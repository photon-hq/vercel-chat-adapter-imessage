import { Message, parseMarkdown } from "chat";
import type {
  Content as SpectrumContent,
  Message as SpectrumMessage,
  Space as SpectrumSpace,
} from "@spectrum-ts/core";
import { encodeThreadId, isDMChatGuid } from "./thread";

/**
 * The provider-agnostic fields a Chat SDK `Message` is built from. Both the
 * gateway (live spectrum-ts `Message`) and the webhook (plain JSON delivery)
 * paths normalize down to this shape.
 */
export interface InboundMessageFields {
  chatGuid: string;
  content: SpectrumContent;
  id: string;
  isOutbound: boolean;
  /** The iMessage line this delivery arrived on, when the source exposes it. */
  phone?: string;
  raw: unknown;
  senderId: string;
  timestamp: Date;
}

/** Build the Chat SDK `Message` from already-normalized inbound fields. */
export function buildChatMessageFromFields(
  fields: InboundMessageFields
): Message {
  const text = extractText(fields.content);

  return new Message({
    id: fields.id,
    threadId: encodeThreadId({ chatGuid: fields.chatGuid, phone: fields.phone }),
    text,
    formatted: parseMarkdown(text),
    author: {
      userId: fields.senderId,
      userName: fields.senderId,
      fullName: fields.senderId,
      isBot: false,
      isMe: fields.isOutbound,
    },
    metadata: { dateSent: fields.timestamp, edited: false },
    attachments: extractAttachments(fields.content).map((a) => ({
      type: getAttachmentType(a.mimeType),
      name: a.name,
      mimeType: a.mimeType,
      size: a.size ?? 0,
    })),
    raw: fields.raw,
    isMention: isDMChatGuid(fields.chatGuid),
  });
}

/** Build the Chat SDK `Message` the adapter surfaces from a spectrum-ts Message. */
export function buildChatMessage(
  message: SpectrumMessage,
  space: SpectrumSpace
): Message {
  return buildChatMessageFromFields({
    id: message.id,
    chatGuid: space.id,
    content: message.content,
    senderId: message.sender?.id ?? "",
    isOutbound: message.direction === "outbound",
    phone: (space as { phone?: string }).phone,
    timestamp: message.timestamp,
    raw: message,
  });
}

function extractText(content: SpectrumContent): string {
  switch (content.type) {
    case "text":
      return content.text;
    case "richlink":
      return String(content.url);
    case "poll":
      return content.title;
    case "group":
      return content.items
        .map((item) => extractText(item.content))
        .filter((t) => t.length > 0)
        .join("\n");
    default:
      return "";
  }
}

interface ExtractedAttachment {
  mimeType: string;
  name: string;
  size?: number;
}

function extractAttachments(content: SpectrumContent): ExtractedAttachment[] {
  const out: ExtractedAttachment[] = [];
  const visit = (c: SpectrumContent): void => {
    if (c.type === "attachment") {
      out.push({ name: c.name, mimeType: c.mimeType, size: c.size });
    } else if (c.type === "voice") {
      const voice = c as { mimeType: string; name?: string; size?: number };
      out.push({
        name: voice.name ?? "voice",
        mimeType: voice.mimeType,
        size: voice.size,
      });
    } else if (c.type === "group") {
      for (const item of c.items) {
        visit(item.content);
      }
    }
  };
  visit(content);
  return out;
}

function getAttachmentType(
  mimeType?: string
): "image" | "video" | "audio" | "file" {
  if (!mimeType) {
    return "file";
  }
  if (mimeType.startsWith("image/")) {
    return "image";
  }
  if (mimeType.startsWith("video/")) {
    return "video";
  }
  if (mimeType.startsWith("audio/")) {
    return "audio";
  }
  return "file";
}
