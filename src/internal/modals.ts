import type { ModalPollMeta } from "../types";

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
 */
export class ModalPollRegistry {
  private readonly byView = new Map<string, ModalPollMeta>();
  private readonly byTitle = new Map<string, ModalPollMeta>();

  register(chatGuid: string, title: string, meta: ModalPollMeta): void {
    this.byView.set(meta.viewId, meta);
    this.byTitle.set(titleKey(chatGuid, title), meta);
  }

  resolveVote(
    chatGuid: string,
    pollTitle: string,
    optionTitle: string
  ): ResolvedVote | undefined {
    const meta = this.byTitle.get(titleKey(chatGuid, pollTitle));
    if (!meta) {
      return undefined;
    }
    const option = meta.options.find((o) => o.label === optionTitle);
    return { meta, value: option?.value ?? optionTitle };
  }
}

function titleKey(chatGuid: string, title: string): string {
  return `${chatGuid}::${title}`;
}
