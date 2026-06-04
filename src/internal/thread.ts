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
  return { chatGuid: threadId.slice(THREAD_PREFIX.length) };
}

/** DM chat GUIDs use the `;-;` separator; group chats use `;+;`. */
export function isDMChatGuid(chatGuid: string): boolean {
  return chatGuid.includes(";-;");
}
