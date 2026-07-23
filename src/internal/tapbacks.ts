import { ValidationError } from "@chat-adapter/shared";
import { type Adapter, type EmojiValue, getEmoji } from "chat";

/**
 * The six standard iMessage tapbacks and their Chat SDK names. Aliases are
 * accepted outbound, while inbound values always normalize to `name`.
 */
const STANDARD_TAPBACKS = [
  { glyph: "❤️", name: "heart", aliases: ["love"] },
  { glyph: "👍", name: "thumbs_up", aliases: ["like"] },
  { glyph: "👎", name: "thumbs_down", aliases: ["dislike"] },
  { glyph: "😂", name: "laugh", aliases: [] },
  { glyph: "‼️", name: "exclamation", aliases: ["emphasize"] },
  { glyph: "❓", name: "question", aliases: [] },
] as const;

const GLYPH_TO_NAME = new Map<string, string>(
  STANDARD_TAPBACKS.map(({ glyph, name }) => [glyph, name])
);

const NAME_TO_GLYPH = new Map<string, string>(
  STANDARD_TAPBACKS.flatMap(({ aliases, glyph, name }) =>
    [name, ...aliases].map((value) => [value, glyph] as const)
  )
);

const SUPPORTED_NAMES = STANDARD_TAPBACKS.flatMap(({ aliases, name }) => [
  name,
  ...aliases,
]).join(", ");

/**
 * Normalize a standard iMessage tapback to its cross-platform Chat SDK name.
 * Unknown reaction strings pass through unchanged so custom/future reactions
 * remain observable through both `emoji.name` and `rawEmoji`.
 */
export function tapbackToEmoji(rawEmoji: string): EmojiValue {
  return getEmoji(GLYPH_TO_NAME.get(rawEmoji) ?? rawEmoji);
}

/** Prefer the parent surfaced to Chat SDK over a multipart child message ID. */
export function getReactionTargetId(target: {
  id?: unknown;
  parentId?: unknown;
}): string | undefined {
  if (typeof target.parentId === "string") {
    return target.parentId;
  }
  return typeof target.id === "string" ? target.id : undefined;
}

/** Build the common Chat SDK fields for an inbound iMessage reaction. */
export function buildInboundReaction(input: {
  adapter: Adapter;
  emoji: string;
  messageId: string;
  raw: unknown;
  senderId: string;
  threadId: string;
}) {
  return {
    adapter: input.adapter,
    threadId: input.threadId,
    messageId: input.messageId,
    emoji: tapbackToEmoji(input.emoji),
    rawEmoji: input.emoji,
    added: true,
    user: {
      userId: input.senderId,
      userName: input.senderId,
      fullName: input.senderId,
      isBot: false,
      isMe: false,
    },
    raw: input.raw,
  };
}

/** Map a Chat SDK emoji name to a standard iMessage tapback glyph. */
export function emojiToTapback(emoji: EmojiValue | string): string {
  const name = typeof emoji === "string" ? emoji : emoji.name;
  const glyph = NAME_TO_GLYPH.get(name);
  if (!glyph) {
    throw new ValidationError(
      "imessage",
      `Unsupported iMessage tapback: "${name}". Supported: ${SUPPORTED_NAMES}`
    );
  }
  return glyph;
}
