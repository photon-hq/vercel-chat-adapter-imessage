import { ValidationError } from "@chat-adapter/shared";
import { ConsoleLogger } from "chat";
import { iMessageAdapter } from "./adapter";
import type { CreateiMessageAdapterOptions } from "./config";

const LOCAL_MODE_REMOVED =
  "Local (on-device) mode was removed from this adapter. Use Spectrum Cloud " +
  "(IMESSAGE_PROJECT_ID + IMESSAGE_PROJECT_SECRET) or a self-hosted gRPC " +
  "endpoint (IMESSAGE_SERVER_URL + IMESSAGE_API_KEY) instead.";

/**
 * Throw if the caller asks for the removed local mode — an explicit
 * `config.local: true`, or `IMESSAGE_LOCAL` set to anything but `"false"`
 * (the legacy "remote" opt-out, still accepted as a no-op).
 */
function rejectLocalMode(explicit: boolean | undefined): void {
  if (explicit === false) {
    return; // explicit `local: false` beats any IMESSAGE_LOCAL env signal
  }
  const env = process.env.IMESSAGE_LOCAL;
  const wantsLocal = explicit ?? Boolean(env && env !== "false");
  if (wantsLocal) {
    throw new ValidationError("imessage", LOCAL_MODE_REMOVED);
  }
}

function assertRemoteCredentials(creds: {
  hasApiKey: boolean;
  hasClients: boolean;
  hasCloud: boolean;
  hasServerUrl: boolean;
}): void {
  if (creds.hasCloud || creds.hasClients) {
    return;
  }
  if (!creds.hasServerUrl) {
    throw new ValidationError(
      "imessage",
      "serverUrl is required. Set IMESSAGE_SERVER_URL (or use IMESSAGE_PROJECT_ID/IMESSAGE_PROJECT_SECRET for Spectrum Cloud), or provide it in config."
    );
  }
  if (!creds.hasApiKey) {
    throw new ValidationError(
      "imessage",
      "apiKey is required. Set IMESSAGE_API_KEY or provide it in config."
    );
  }
}

/**
 * Construct an {@link iMessageAdapter}, filling unset options from environment
 * variables. Requires remote credentials: cloud `projectId` + `projectSecret`,
 * or self-host `clients` / `serverUrl` + `apiKey`.
 */
export function createiMessageAdapter(
  config?: CreateiMessageAdapterOptions
): iMessageAdapter {
  rejectLocalMode(config?.local);

  const logger = config?.logger ?? new ConsoleLogger("info").child("imessage");

  const projectId = config?.projectId ?? process.env.IMESSAGE_PROJECT_ID;
  const projectSecret =
    config?.projectSecret ?? process.env.IMESSAGE_PROJECT_SECRET;
  const clients = config?.clients;
  // Normalize once: trim so surrounding whitespace neither passes validation
  // nor reaches the adapter (where it would break the gRPC address/token).
  const serverUrl = (
    config?.serverUrl ?? process.env.IMESSAGE_SERVER_URL
  )?.trim();
  const apiKey = (config?.apiKey ?? process.env.IMESSAGE_API_KEY)?.trim();
  const phone = config?.phone ?? process.env.IMESSAGE_PHONE;
  const webhookSecret = (
    config?.webhookSecret ?? process.env.IMESSAGE_WEBHOOK_SECRET
  )?.trim();

  const hasClients = Array.isArray(clients)
    ? clients.length > 0
    : Boolean(clients);
  const hasCloud = Boolean(config?.credentials || (projectId && projectSecret));
  const hasServerUrl = Boolean(serverUrl);
  const hasApiKey = Boolean(apiKey);

  assertRemoteCredentials({ hasApiKey, hasClients, hasCloud, hasServerUrl });

  return new iMessageAdapter({
    logger,
    credentials: config?.credentials,
    projectId,
    projectSecret,
    clients,
    serverUrl,
    apiKey,
    phone,
    webhookSecret,
    webhookVerifier: config?.webhookVerifier,
  });
}
