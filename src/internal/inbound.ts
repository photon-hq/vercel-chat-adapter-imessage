import { Message, parseMarkdown } from "chat";
import type {
  Content as SpectrumContent,
  Message as SpectrumMessage,
  Space as SpectrumSpace,
} from "spectrum-ts";
import { encodeThreadId, isDMChatGuid } from "./thread";

/** Build the Chat SDK `Message` the adapter surfaces from a spectrum-ts Message. */
export function buildChatMessage(
  message: SpectrumMessage,
  space: SpectrumSpace
): Message {
  const chatGuid = space.id;
  const text = extractText(message.content);
  const sender = message.sender?.id ?? "";

  return new Message({
    id: message.id,
    threadId: encodeThreadId({ chatGuid }),
    text,
    formatted: parseMarkdown(text),
    author: {
      userId: sender,
      userName: sender,
      fullName: sender,
      isBot: false,
      isMe: message.direction === "outbound",
    },
    metadata: { dateSent: message.timestamp, edited: false },
    attachments: extractAttachments(message.content).map((a) => ({
      type: getAttachmentType(a.mimeType),
      name: a.name,
      mimeType: a.mimeType,
      size: a.size ?? 0,
    })),
    raw: message,
    isMention: isDMChatGuid(chatGuid),
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
  if (!mimeType) return "file";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "file";
}
