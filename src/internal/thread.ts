import { ValidationError } from "@chat-adapter/shared";
import type { iMessageThreadId } from "../types";

const THREAD_PREFIX = "imessage:";
// Separates the chat GUID from the optional sending line. `~` never appears in
// a chat GUID or a line, so legacy `imessage:<chatGuid>` IDs stay valid.
const LINE_SEP = "~";

export function encodeThreadId(platformData: iMessageThreadId): string {
  const { chatGuid, phone } = platformData;
  return phone
    ? `${THREAD_PREFIX}${chatGuid}${LINE_SEP}${phone}`
    : `${THREAD_PREFIX}${chatGuid}`;
}

export function decodeThreadId(threadId: string): iMessageThreadId {
  if (!threadId.startsWith(THREAD_PREFIX)) {
    throw new ValidationError(
      "imessage",
      `Invalid iMessage thread ID: ${threadId}`
    );
  }
  const rest = threadId.slice(THREAD_PREFIX.length);
  const sepIndex = rest.indexOf(LINE_SEP);
  const chatGuid = sepIndex === -1 ? rest : rest.slice(0, sepIndex);
  const phone = sepIndex === -1 ? undefined : rest.slice(sepIndex + 1);
  if (!chatGuid) {
    throw new ValidationError(
      "imessage",
      `Invalid iMessage thread ID: ${threadId} (empty chat GUID)`
    );
  }
  return phone ? { chatGuid, phone } : { chatGuid };
}

/** DM chat GUIDs use the `;-;` separator; group chats use `;+;`. */
export function isDMChatGuid(chatGuid: string): boolean {
  return chatGuid.includes(";-;");
}
