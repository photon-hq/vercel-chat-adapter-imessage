// ---------------------------------------------------------------------------
// Shared OTel span attribute constants and helpers for chat-adapter-imessage
// ---------------------------------------------------------------------------

// ---- Attribute name constants ------------------------------------------------

/** Common attributes */
export const ATTR_SERVICE_NAME = "service.name" as const;
export const ATTR_IMESSAGE_MODE = "imessage.mode" as const;
export const ATTR_IMESSAGE_CHAT_GUID = "imessage.chat_guid" as const;
export const ATTR_IMESSAGE_THREAD_ID = "imessage.thread_id" as const;
export const ATTR_IMESSAGE_IS_GROUP_CHAT = "imessage.is_group_chat" as const;
export const ATTR_IMESSAGE_MESSAGE_ID = "imessage.message_id" as const;
export const ATTR_IMESSAGE_HAS_ATTACHMENTS =
  "imessage.has_attachments" as const;
export const ATTR_IMESSAGE_ATTACHMENT_COUNT =
  "imessage.attachment_count" as const;

/** Gateway-specific attributes */
export const ATTR_GATEWAY_DURATION_MS =
  "imessage.gateway.duration_ms" as const;
export const ATTR_GATEWAY_MESSAGES_RECEIVED =
  "imessage.gateway.messages_received" as const;
export const ATTR_GATEWAY_ERRORS = "imessage.gateway.errors" as const;
export const ATTR_GATEWAY_ABORTED = "imessage.gateway.aborted" as const;

/** Error attributes */
export const ATTR_ERROR_TYPE = "imessage.error.type" as const;

// ---- Span name constants -----------------------------------------------------

export const SPAN_INITIALIZE = "adapter.initialize" as const;
export const SPAN_POST_MESSAGE = "adapter.post_message" as const;
export const SPAN_EDIT_MESSAGE = "adapter.edit_message" as const;
export const SPAN_DELETE_MESSAGE = "adapter.delete_message" as const;
export const SPAN_FETCH_MESSAGES = "adapter.fetch_messages" as const;
export const SPAN_FETCH_THREAD = "adapter.fetch_thread" as const;
export const SPAN_ADD_REACTION = "adapter.add_reaction" as const;
export const SPAN_REMOVE_REACTION = "adapter.remove_reaction" as const;
export const SPAN_START_TYPING = "adapter.start_typing" as const;
export const SPAN_OPEN_MODAL = "adapter.open_modal" as const;
export const SPAN_GATEWAY_LISTENER = "adapter.gateway_listener" as const;
export const SPAN_GATEWAY_RUNNER = "adapter.gateway_runner" as const;
export const SPAN_MESSAGE_RECEIVE = "message.receive" as const;
export const SPAN_POLL_VOTE_RECEIVE = "poll_vote.receive" as const;
export const SPAN_SDK_CONNECT = "sdk.connect" as const;
export const SPAN_SDK_SEND_MESSAGE = "sdk.send_message" as const;
export const SPAN_SDK_SEND_ATTACHMENT = "sdk.send_attachment" as const;
export const SPAN_SDK_DISCONNECT = "sdk.disconnect" as const;
export const SPAN_FILES_WRITE_TEMP = "files.write_temp" as const;
export const SPAN_FILES_CLEANUP = "files.cleanup" as const;

// ---- Helpers -----------------------------------------------------------------

/**
 * Redact phone numbers in chat GUIDs.
 * "iMessage;-;+15551234567" -> "iMessage;-;+1555***4567"
 * To disable, set otel.redactPII to false in adapter config.
 */
export function redactChatGuid(guid: string): string {
  return guid.replace(/(\+\d{4})\d{3}(\d{4})/, "$1***$2");
}

/**
 * Redact phone numbers inside encoded thread IDs.
 * "imessage:iMessage;-;+15551234567" -> "imessage:iMessage;-;+1555***4567"
 */
export function redactThreadId(threadId: string): string {
  if (!threadId.startsWith("imessage:")) {
    return redactChatGuid(threadId);
  }

  return `imessage:${redactChatGuid(threadId.slice("imessage:".length))}`;
}

/**
 * Build common span attributes for adapter operations.
 */
export function buildCommonAttributes(
  mode: "local" | "remote",
  opts?: {
    serviceName?: string;
    chatGuid?: string;
    threadId?: string;
    messageId?: string;
    isGroupChat?: boolean;
    attachmentCount?: number;
    redactPII?: boolean;
  },
): Record<string, string | number | boolean> {
  const redact = opts?.redactPII ?? true;

  const attrs: Record<string, string | number | boolean> = {
    [ATTR_IMESSAGE_MODE]: mode,
  };

  if (opts?.serviceName !== undefined) {
    attrs[ATTR_SERVICE_NAME] = opts.serviceName;
  }

  if (opts?.chatGuid !== undefined) {
    attrs[ATTR_IMESSAGE_CHAT_GUID] = redact
      ? redactChatGuid(opts.chatGuid)
      : opts.chatGuid;
  }

  if (opts?.threadId !== undefined) {
    attrs[ATTR_IMESSAGE_THREAD_ID] = redact
      ? redactThreadId(opts.threadId)
      : opts.threadId;
  }

  if (opts?.messageId !== undefined) {
    attrs[ATTR_IMESSAGE_MESSAGE_ID] = opts.messageId;
  }

  if (opts?.isGroupChat !== undefined) {
    attrs[ATTR_IMESSAGE_IS_GROUP_CHAT] = opts.isGroupChat;
  }

  if (opts?.attachmentCount !== undefined) {
    attrs[ATTR_IMESSAGE_ATTACHMENT_COUNT] = opts.attachmentCount;
    attrs[ATTR_IMESSAGE_HAS_ATTACHMENTS] = opts.attachmentCount > 0;
  }

  return attrs;
}
