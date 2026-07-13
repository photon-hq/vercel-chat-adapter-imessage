import type { SelectOptionElement } from "chat";

/** Thread ID components for iMessage */
export interface iMessageThreadId {
  /** Chat GUID (e.g., "iMessage;-;+1234567890") */
  chatGuid: string;
  /**
   * Sending line, when known — encoded in the thread ID so it survives a
   * cold-cache reply invocation where the Space must be rebuilt.
   */
  phone?: string;
}

/**
 * Explicit self-hosted iMessage client entry, passed straight through to
 * spectrum-ts's `imessage.config({ clients: [...] })`.
 *
 * - `address`: gRPC endpoint (`host:port`) of an `@photon-ai/advanced-imessage`
 *   server.
 * - `token`: auth token for that server.
 * - `phone`: the number this client sends/receives as (routing key in
 *   multi-number setups; use the `"shared"` sentinel for single-number).
 */
export interface IMessageClientEntry {
  address: string;
  phone: string;
  token: string;
}

/**
 * Bookkeeping for a Chat SDK modal that was rendered as an iMessage native
 * poll. iMessage poll votes arrive as `poll_option` messages that carry only
 * the poll's title and the chosen option's title (no poll GUID), so we match
 * incoming votes back to the originating modal by `${chatGuid}::${pollTitle}`
 * and keep the original Chat SDK option list to recover each option's `value`.
 */
export interface ModalPollMeta {
  /** callbackId of the originating modal (routed to `onModalSubmit`). */
  callbackId: string;
  /** Optional context id threaded back through `processModalSubmit`. */
  contextId?: string;
  /** Original Chat SDK select options (label -> value mapping). */
  options: SelectOptionElement[];
  /** Optional private metadata threaded back through `processModalSubmit`. */
  privateMetadata?: string;
  /** id of the `Select` child whose value the vote maps to. */
  selectId: string;
  /** id of the sent poll message (used as the modal `viewId`). */
  viewId: string;
}
