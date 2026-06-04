import { ValidationError } from "@chat-adapter/shared";
import type { iMessageThreadId } from "../types";

const THREAD_PREFIX = "imessage:";

export function encodeThreadId(platformData: iMessageThreadId): string {
  return `${THREAD_PREFIX}${platformData.chatGuid}`;
}

export function decodeThreadId(threadId: string): iMessageThreadId {
  if (!threadId.startsWith(THREAD_PREFIX)) {
    throw new ValidationError(
      "imessage",
      `Invalid iMessage thread ID: ${threadId}`
    );
  }
  const chatGuid = threadId.slice(THREAD_PREFIX.length);
  if (!chatGuid) {
    throw new ValidationError(
      "imessage",
      `Invalid iMessage thread ID: ${threadId} (empty chat GUID)`
    );
  }
  return { chatGuid };
}

/** DM chat GUIDs use the `;-;` separator; group chats use `;+;`. */
export function isDMChatGuid(chatGuid: string): boolean {
  return chatGuid.includes(";-;");
}

const DM_SEPARATOR = ";-;";

/**
 * Extract the peer address from a DM chat GUID (`<service>;-;<address>`, e.g.
 * `any;-;+15550100`). Returns `""` for a non-DM GUID. spectrum-ts rebuilds a
 * sendable DM `Space` from this address — `imessage(app).space([address])`.
 */
export function dmAddressFromChatGuid(chatGuid: string): string {
  const idx = chatGuid.indexOf(DM_SEPARATOR);
  return idx === -1 ? "" : chatGuid.slice(idx + DM_SEPARATOR.length);
}
