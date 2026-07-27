import { createHmac, timingSafeEqual } from "node:crypto";
import type { Content as SpectrumContent } from "@spectrum-ts/core";
import type { Message } from "chat";
import type { iMessageWebhookVerifier } from "../config";
import { buildChatMessageFromFields } from "./inbound";

/**
 * Spectrum Cloud webhook delivery. Spectrum's service POSTs message events to a
 * registered URL as JSON, signed with a per-webhook secret.
 *
 * See https://photon.codes/docs/webhooks/overview
 */

/** Lowercase header names — `Headers.get` is case-insensitive per the spec. */
export const SPECTRUM_SIGNATURE_HEADER = "x-spectrum-signature";
export const SPECTRUM_TIMESTAMP_HEADER = "x-spectrum-timestamp";
export const SPECTRUM_EVENT_HEADER = "x-spectrum-event";

/** The only event Spectrum Cloud delivers today. */
export const SPECTRUM_MESSAGES_EVENT = "messages";

/** Reject deliveries whose timestamp drifts more than this from now (replay guard). */
const TIMESTAMP_TOLERANCE_SEC = 5 * 60;

export interface SpectrumWebhookSpace {
  id: string;
  phone?: string;
  platform?: string;
  type?: "dm" | "group";
}

export interface SpectrumWebhookMessage {
  content: { type?: string; [key: string]: unknown };
  direction?: "inbound" | "outbound";
  id: string;
  platform?: string;
  sender?: { id: string; platform?: string };
  space?: SpectrumWebhookSpace;
  timestamp?: string;
}

export interface SpectrumWebhookPayload {
  event: string;
  message: SpectrumWebhookMessage;
  space: SpectrumWebhookSpace;
}

export type WebhookVerification =
  | { ok: true }
  | { ok: false; reason: string; status: number };

export type WebhookRequestVerifier = (
  request: Request,
  rawBody: string
) => Promise<WebhookVerification>;

/**
 * Normalize native signature verification and trusted-forwarder verification
 * behind one request-level strategy. A custom verifier takes precedence.
 */
export function createWebhookVerifier(options: {
  secret?: string;
  verifier?: iMessageWebhookVerifier;
}): WebhookRequestVerifier | undefined {
  const customVerifier = options.verifier;
  if (customVerifier) {
    return async (request, rawBody) => {
      try {
        return (await customVerifier(request, rawBody))
          ? { ok: true }
          : { ok: false, reason: "webhook verification failed", status: 401 };
      } catch {
        return {
          ok: false,
          reason: "webhook verification failed",
          status: 401,
        };
      }
    };
  }

  const secret = options.secret;
  if (!secret) {
    return;
  }

  return async (request, rawBody) =>
    verifySpectrumSignature({
      secret,
      signature: request.headers.get(SPECTRUM_SIGNATURE_HEADER),
      timestamp: request.headers.get(SPECTRUM_TIMESTAMP_HEADER),
      rawBody,
    });
}

/**
 * Verify a Spectrum Cloud webhook's HMAC-SHA256 signature.
 *
 * The signing base is `v0:{timestamp}:{rawBody}` and the header value is
 * `v0=<lowercase hex>`. `rawBody` MUST be the exact bytes received — verify
 * before parsing JSON.
 */
export function verifySpectrumSignature(opts: {
  now?: number;
  rawBody: string;
  secret: string;
  signature: string | null;
  timestamp: string | null;
}): WebhookVerification {
  const { rawBody, secret, signature, timestamp } = opts;
  if (!(signature && timestamp)) {
    return { ok: false, status: 400, reason: "missing signature headers" };
  }

  const nowSec = opts.now ?? Math.floor(Date.now() / 1000);
  const age = Math.abs(nowSec - Number(timestamp));
  if (!Number.isFinite(age) || age > TIMESTAMP_TOLERANCE_SEC) {
    return { ok: false, status: 400, reason: "stale or invalid timestamp" };
  }

  const expected = `v0=${createHmac("sha256", secret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex")}`;

  // Constant-time compare; lengths must match first or timingSafeEqual throws.
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, status: 401, reason: "bad signature" };
  }

  return { ok: true };
}

/**
 * Build the Chat SDK `Message` from a Spectrum Cloud webhook delivery.
 *
 * The wire format is the spectrum-ts `Content` union with methods stripped, so
 * the message `content` is structurally compatible with the inbound content
 * extractors (which only read metadata fields).
 */
export function buildChatMessageFromWebhook(
  message: SpectrumWebhookMessage,
  space: SpectrumWebhookSpace
): Message {
  return buildChatMessageFromFields({
    id: message.id,
    chatGuid: space.id,
    content: message.content as unknown as SpectrumContent,
    senderId: message.sender?.id ?? "",
    isOutbound: message.direction === "outbound",
    phone: space.phone ?? message.space?.phone,
    timestamp: message.timestamp ? new Date(message.timestamp) : new Date(),
    raw: message,
  });
}
