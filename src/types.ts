/** Thread ID components for iMessage */
export interface iMessageThreadId {
  /** Chat GUID (e.g., "iMessage;-;+1234567890") */
  chatGuid: string;
}

/** Normalized message data from either local or remote SDK */
export interface iMessageGatewayMessageData {
  /** Attachments */
  attachments: iMessageAttachment[];
  /** Chat GUID this message belongs to */
  chatId: string;
  /** Message timestamp (ISO string) */
  date: string;
  /** Message GUID */
  guid: string;
  /** Whether the message is from the current user */
  isFromMe: boolean;
  /** Whether this is a group chat */
  isGroupChat: boolean;
  /** Raw data from the SDK */
  raw?: unknown;
  /** Sender identifier (phone/email) */
  sender: string;
  /** Sender display name */
  senderName: string | null;
  /** Source SDK */
  source: "local" | "remote";
  /** Message text content */
  text: string | null;
}

export interface iMessageAttachment {
  filename: string;
  id: string;
  mimeType: string;
  size: number;
}

/**
 * Payload shape from imessage-kit's native webhook.
 * The SDK POSTs the Message object directly when webhook config is set.
 */
export interface NativeWebhookPayload {
  attachments: Array<{
    createdAt: string;
    filename: string;
    id: string;
    isImage: boolean;
    mimeType: string;
    path: string;
    size: number;
  }>;
  chatId: string;
  date: string;
  guid: string;
  isFromMe: boolean;
  isGroupChat: boolean;
  isReaction: boolean;
  sender: string;
  senderName: string | null;
  service: string;
  text: string | null;
}
