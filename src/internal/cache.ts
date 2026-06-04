import type {
  Message as SpectrumMessage,
  Space as SpectrumSpace,
} from "spectrum-ts";

const DEFAULT_MAX_SPACES = 256;
const DEFAULT_MAX_MESSAGES = 1024;

/**
 * Bounded, insertion-order (FIFO-evicted) cache of the Spaces and Messages seen
 * on the inbound stream. The stateless, threadId-addressed Adapter methods
 * (`postMessage`, `addReaction`, …) resolve their target Space/Message from
 * here — spectrum-ts can construct neither from a bare id.
 */
export class InboundCache {
  private readonly spaces = new Map<string, SpectrumSpace>();
  private readonly messages = new Map<string, SpectrumMessage>();
  private readonly maxSpaces: number;
  private readonly maxMessages: number;

  constructor(
    maxSpaces = DEFAULT_MAX_SPACES,
    maxMessages = DEFAULT_MAX_MESSAGES
  ) {
    this.maxSpaces = maxSpaces;
    this.maxMessages = maxMessages;
  }

  /** Cache the Space + Message (and any group sub-items) from one inbound event. */
  remember(space: SpectrumSpace, message: SpectrumMessage): void {
    this.rememberSpace(space);
    this.rememberMessage(message);
    if (message.content.type === "group") {
      for (const item of message.content.items) {
        this.rememberMessage(item);
      }
    }
  }

  rememberSpace(space: SpectrumSpace): void {
    this.spaces.set(space.id, space);
    evict(this.spaces, this.maxSpaces);
  }

  rememberMessage(message: SpectrumMessage): void {
    this.messages.set(message.id, message);
    evict(this.messages, this.maxMessages);
  }

  getSpace(chatGuid: string): SpectrumSpace | undefined {
    return this.spaces.get(chatGuid);
  }

  getMessage(id: string): SpectrumMessage | undefined {
    return this.messages.get(id);
  }
}

function evict(map: Map<string, unknown>, max: number): void {
  if (map.size <= max) {
    return;
  }
  const overflow = map.size - max;
  let removed = 0;
  for (const key of map.keys()) {
    if (removed >= overflow) {
      break;
    }
    map.delete(key);
    removed += 1;
  }
}
