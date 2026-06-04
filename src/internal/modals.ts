import type { ModalPollMeta } from "../types";

const DEFAULT_MAX_MODALS = 512;

export interface ResolvedVote {
  meta: ModalPollMeta;
  value: string;
}

/**
 * Tracks Chat SDK modals that were rendered as iMessage native polls and maps
 * inbound votes back to them.
 *
 * iMessage `poll_option` votes carry no poll GUID — only the poll title and the
 * chosen option's title — so votes are matched by `${chatGuid}::${pollTitle}`
 * and the Chat SDK option `value` is recovered from the stored option list.
 *
 * Entries are retained (not deleted on the first vote) so multi-participant
 * polls keep resolving, and bounded with FIFO eviction so the map cannot grow
 * without bound over the adapter's lifetime.
 */
export class ModalPollRegistry {
  private readonly byTitle = new Map<string, ModalPollMeta>();
  private readonly maxEntries: number;

  constructor(maxEntries = DEFAULT_MAX_MODALS) {
    this.maxEntries = maxEntries;
  }

  register(chatGuid: string, title: string, meta: ModalPollMeta): void {
    const key = titleKey(chatGuid, title);
    // Re-registering moves the key to the most-recent position.
    this.byTitle.delete(key);
    this.byTitle.set(key, meta);
    if (this.byTitle.size > this.maxEntries) {
      const oldest = this.byTitle.keys().next().value;
      if (oldest !== undefined) {
        this.byTitle.delete(oldest);
      }
    }
  }

  resolveVote(
    chatGuid: string,
    pollTitle: string,
    optionTitle: string
  ): ResolvedVote | undefined {
    const meta = this.byTitle.get(titleKey(chatGuid, pollTitle));
    if (!meta) {
      return;
    }
    const option = meta.options.find((o) => o.label === optionTitle);
    if (!option) {
      // Unknown option label — don't fabricate an unregistered submit value.
      return;
    }
    return { meta, value: option.value };
  }
}

function titleKey(chatGuid: string, title: string): string {
  return `${chatGuid}::${title}`;
}
