import { ValidationError } from "@chat-adapter/shared";
import { ConsoleLogger } from "chat";
import { iMessageAdapter } from "./adapter";
import type { CreateiMessageAdapterOptions } from "./config";

/**
 * Construct an {@link iMessageAdapter}, filling unset options from environment
 * variables.
 *
 * Mode is chosen by an explicit local signal first — `config.local`, then
 * `IMESSAGE_LOCAL` — otherwise remote when remote credentials are present (cloud
 * `projectId` + `projectSecret`, or self-host `clients` / `serverUrl` +
 * `apiKey`), else local.
 */
export function createiMessageAdapter(
  config?: CreateiMessageAdapterOptions
): iMessageAdapter {
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

  const hasClients = Array.isArray(clients)
    ? clients.length > 0
    : Boolean(clients);
  const hasCloud = Boolean(projectId && projectSecret);
  const hasServerUrl = Boolean(serverUrl);
  const hasApiKey = Boolean(apiKey);
  const hasRemoteCreds = hasCloud || hasClients || (hasServerUrl && hasApiKey);

  // Precedence: an explicit local signal (config.local, then IMESSAGE_LOCAL)
  // wins; otherwise choose remote when remote credentials are present.
  let local: boolean;
  if (config?.local !== undefined) {
    local = config.local;
  } else if (process.env.IMESSAGE_LOCAL === "false") {
    local = false;
  } else if (process.env.IMESSAGE_LOCAL !== undefined) {
    local = true;
  } else {
    local = !hasRemoteCreds;
  }

  if (local) {
    return new iMessageAdapter({ local: true, logger, serverUrl, apiKey });
  }

  if (!hasCloud && !hasClients) {
    if (!hasServerUrl) {
      throw new ValidationError(
        "imessage",
        "serverUrl is required when local is false. Set IMESSAGE_SERVER_URL (or use IMESSAGE_PROJECT_ID/IMESSAGE_PROJECT_SECRET for Spectrum Cloud), or provide it in config."
      );
    }
    if (!hasApiKey) {
      throw new ValidationError(
        "imessage",
        "apiKey is required when local is false. Set IMESSAGE_API_KEY or provide it in config."
      );
    }
  }

  return new iMessageAdapter({
    local: false,
    logger,
    projectId,
    projectSecret,
    clients,
    serverUrl,
    apiKey,
    phone,
  });
}
