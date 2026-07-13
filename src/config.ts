import { ValidationError } from "@chat-adapter/shared";
import type { Logger } from "chat";
import type { IMessageClientEntry } from "./types";

export const SHARED_PHONE = "shared";

/** Provider config shape accepted by `imessage.config(...)`. */
export interface IMessageProviderConfig {
  clients?: IMessageClientEntry[];
}

export interface iMessageAdapterConfig {
  /** Legacy self-host token. Mapped to a `clients` entry's `token`. */
  apiKey?: string;
  /** Explicit self-host gRPC clients (advanced). */
  clients?: IMessageClientEntry | IMessageClientEntry[];
  /**
   * @deprecated Local (on-device) mode was removed. `false` is accepted as a
   * no-op for back-compat; `true` throws.
   */
  local?: false;
  logger: Logger;
  /** Routing/identity phone for legacy self-host (defaults to `"shared"`). */
  phone?: string;
  /** Spectrum Cloud project id (recommended path). */
  projectId?: string;
  /** Spectrum Cloud project secret (recommended path). */
  projectSecret?: string;
  /** Legacy self-host endpoint. Now a gRPC `host:port` (see README). */
  serverUrl?: string;
  /** Per-webhook signing secret for verifying Spectrum Cloud deliveries. */
  webhookSecret?: string;
}

/** @deprecated Use {@link iMessageAdapterConfig}. */
export type iMessageAdapterRemoteConfig = iMessageAdapterConfig;

export interface CreateiMessageAdapterOptions {
  apiKey?: string;
  clients?: IMessageClientEntry | IMessageClientEntry[];
  /**
   * @deprecated Local (on-device) mode was removed. `false` is accepted as a
   * no-op for back-compat; `true` throws.
   */
  local?: boolean;
  logger?: Logger;
  phone?: string;
  projectId?: string;
  projectSecret?: string;
  serverUrl?: string;
  webhookSecret?: string;
}

const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Normalize a legacy `serverUrl` into a gRPC `host:port` address.
 *
 * `@photon-ai/advanced-imessage` (the transport spectrum-ts uses) speaks gRPC,
 * not HTTP/Socket.IO, so any scheme is stripped and a default `:443` port is
 * appended when none is present.
 */
export function deriveAddress(serverUrl: string): string {
  const trimmed = serverUrl.trim();
  const hasScheme = URL_SCHEME_RE.test(trimmed);
  // Parse via URL so host/port (including bracketed IPv6) are handled
  // correctly. `URL.hostname` already wraps IPv6 in brackets — don't re-wrap.
  const url = new URL(hasScheme ? trimmed : `https://${trimmed}`);
  return `${url.hostname}:${url.port || "443"}`;
}

/** The resolved remote-auth fields the adapter holds. */
export interface RemoteAuth {
  apiKey?: string;
  clients?: IMessageClientEntry[];
  phone?: string;
  projectId?: string;
  projectSecret?: string;
  serverUrl?: string;
}

/**
 * Translate the adapter's stored remote config into the `imessage.config(...)`
 * payload plus any Spectrum Cloud credentials.
 */
export function resolveSpectrumConfig(auth: RemoteAuth): {
  projectId?: string;
  projectSecret?: string;
  providerConfig: IMessageProviderConfig;
} {
  if (auth.projectId && auth.projectSecret) {
    return {
      providerConfig: {},
      projectId: auth.projectId,
      projectSecret: auth.projectSecret,
    };
  }
  if (auth.clients?.length) {
    return { providerConfig: { clients: auth.clients } };
  }
  if (auth.serverUrl && auth.apiKey) {
    return {
      providerConfig: {
        clients: [
          {
            address: deriveAddress(auth.serverUrl),
            token: auth.apiKey,
            phone: auth.phone ?? SHARED_PHONE,
          },
        ],
      },
    };
  }
  throw new ValidationError(
    "imessage",
    "The adapter requires Spectrum Cloud credentials (projectId + projectSecret), explicit clients, or serverUrl + apiKey."
  );
}
