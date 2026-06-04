import { ValidationError } from "@chat-adapter/shared";
import type { Logger } from "chat";
import type { IMessageClientEntry } from "./types";

export const SHARED_PHONE = "shared";

/** Provider config shape accepted by `imessage.config(...)`. */
export type IMessageProviderConfig =
  | { local: true }
  | { clients?: IMessageClientEntry[]; local?: false };

export interface iMessageAdapterLocalConfig {
  /** Unused in local mode; accepted for symmetry/back-compat. */
  apiKey?: string;
  local: true;
  logger: Logger;
  /** Unused in local mode; accepted for symmetry/back-compat. */
  serverUrl?: string;
}

export interface iMessageAdapterRemoteConfig {
  /** Legacy self-host token. Mapped to a `clients` entry's `token`. */
  apiKey?: string;
  /** Explicit self-host gRPC clients (advanced). */
  clients?: IMessageClientEntry | IMessageClientEntry[];
  local: false;
  logger: Logger;
  /** Routing/identity phone for legacy self-host (defaults to `"shared"`). */
  phone?: string;
  /** Spectrum Cloud project id (recommended remote path). */
  projectId?: string;
  /** Spectrum Cloud project secret (recommended remote path). */
  projectSecret?: string;
  /** Legacy self-host endpoint. Now a gRPC `host:port` (see README). */
  serverUrl?: string;
}

export type iMessageAdapterConfig =
  | iMessageAdapterLocalConfig
  | iMessageAdapterRemoteConfig;

export interface CreateiMessageAdapterOptions {
  apiKey?: string;
  clients?: IMessageClientEntry | IMessageClientEntry[];
  local?: boolean;
  logger?: Logger;
  phone?: string;
  projectId?: string;
  projectSecret?: string;
  serverUrl?: string;
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
 * Translate the adapter's stored config into the `imessage.config(...)` payload
 * plus any Spectrum Cloud credentials.
 */
export function resolveSpectrumConfig(
  local: boolean,
  auth: RemoteAuth
): {
  projectId?: string;
  projectSecret?: string;
  providerConfig: IMessageProviderConfig;
} {
  if (local) {
    return { providerConfig: { local: true } };
  }
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
    "Remote mode requires Spectrum Cloud credentials (projectId + projectSecret), explicit clients, or serverUrl + apiKey."
  );
}
