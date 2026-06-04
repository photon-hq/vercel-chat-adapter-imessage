import { ValidationError } from "@chat-adapter/shared";
import type { EmojiValue, FileUpload } from "chat";
import { attachment, type ContentBuilder } from "spectrum-ts";

const EMOJI_GLYPHS: Record<string, string> = {
  heart: "❤️",
  love: "❤️",
  thumbs_up: "👍",
  like: "👍",
  thumbs_down: "👎",
  dislike: "👎",
  laugh: "😂",
  emphasize: "‼️",
  exclamation: "‼️",
  question: "❓",
};

/**
 * Map a Chat SDK emoji (name or `EmojiValue`) to the glyph spectrum-ts maps to
 * an iMessage tapback. Throws on an unsupported emoji.
 */
export function emojiToGlyph(emoji: EmojiValue | string): string {
  const name = typeof emoji === "string" ? emoji : emoji.name;
  const glyph = EMOJI_GLYPHS[name];
  if (!glyph) {
    throw new ValidationError(
      "imessage",
      `Unsupported iMessage tapback: "${name}". Supported: heart, thumbs_up, thumbs_down, laugh, emphasize, question`
    );
  }
  return glyph;
}

/** Convert a Chat SDK file upload into a spectrum-ts attachment content builder. */
export async function fileToAttachment(
  file: FileUpload
): Promise<ContentBuilder> {
  const data = file.data;
  let buffer: Buffer;
  if (Buffer.isBuffer(data)) {
    buffer = data;
  } else if (data instanceof Blob) {
    buffer = Buffer.from(await data.arrayBuffer());
  } else {
    buffer = Buffer.from(data as ArrayBuffer);
  }

  const name = file.filename || "attachment";
  const mimeType = (file as { mimeType?: string }).mimeType;
  // `attachment(buffer, …)` derives MIME from `name`'s extension and throws if
  // it can't — pass an explicit type, or fall back when there's no extension.
  const options = mimeType
    ? { name, mimeType }
    : name.includes(".")
      ? { name }
      : { name, mimeType: "application/octet-stream" };

  return attachment(buffer, options);
}
