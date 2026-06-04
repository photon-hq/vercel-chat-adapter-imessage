import { ValidationError } from "@chat-adapter/shared";
import { ConsoleLogger } from "chat";
import { iMessageAdapter } from "./adapter";
import type { CreateiMessageAdapterOptions } from "./config";

/**
 * Construct an {@link iMessageAdapter}, filling unset options from environment
 * variables. Mode precedence: cloud (`projectId` + `projectSecret`) → self-host
 * (`clients`, or `serverUrl` + `apiKey`) → local (`IMESSAGE_LOCAL !== "false"`).
 */
export function createiMessageAdapter(
  config?: CreateiMessageAdapterOptions
): iMessageAdapter {
  const local = config?.local ?? process.env.IMESSAGE_LOCAL !== "false";
  const logger = config?.logger ?? new ConsoleLogger("info").child("imessage");

  if (local) {
    return new iMessageAdapter({
      local: true,
      logger,
      serverUrl: config?.serverUrl ?? process.env.IMESSAGE_SERVER_URL,
      apiKey: config?.apiKey ?? process.env.IMESSAGE_API_KEY,
    });
  }

  const projectId = config?.projectId ?? process.env.IMESSAGE_PROJECT_ID;
  const projectSecret =
    config?.projectSecret ?? process.env.IMESSAGE_PROJECT_SECRET;
  const clients = config?.clients;
  const serverUrl = config?.serverUrl ?? process.env.IMESSAGE_SERVER_URL;
  const apiKey = config?.apiKey ?? process.env.IMESSAGE_API_KEY;
  const phone = config?.phone ?? process.env.IMESSAGE_PHONE;

  if (!(projectId && projectSecret) && !clients) {
    if (!serverUrl) {
      throw new ValidationError(
        "imessage",
        "serverUrl is required when local is false. Set IMESSAGE_SERVER_URL (or use IMESSAGE_PROJECT_ID/IMESSAGE_PROJECT_SECRET for Spectrum Cloud), or provide it in config."
      );
    }
    if (!apiKey) {
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
