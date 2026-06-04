import { extractFiles, ValidationError } from "@chat-adapter/shared";
import type {
  Adapter,
  AdapterPostableMessage,
  ChatInstance,
  EmojiValue,
  FetchOptions,
  FetchResult,
  FormattedContent,
  Logger,
  Message,
  ModalElement,
  RawMessage,
  SelectElement,
  ThreadInfo,
  WebhookOptions,
} from "chat";
import { NotImplementedError } from "chat";
import {
  poll as pollContent,
  Spectrum,
  type SpectrumInstance,
  type Message as SpectrumMessage,
  type Space as SpectrumSpace,
  text as textContent,
} from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { type iMessageAdapterConfig, resolveSpectrumConfig } from "./config";
import { InboundCache } from "./internal/cache";
import { MessagePump } from "./internal/gateway";
import { buildChatMessage } from "./internal/inbound";
import { ModalPollRegistry } from "./internal/modals";
import { emojiToGlyph, fileToAttachment } from "./internal/outbound";
import { decodeThreadId, encodeThreadId, isDMChatGuid } from "./internal/thread";
import { iMessageFormatConverter } from "./markdown";
import type { IMessageClientEntry, iMessageThreadId } from "./types";

const TYPING_DURATION_MS = 3000;

export class iMessageAdapter implements Adapter {
  readonly name = "imessage";
  readonly userName: string = "";
  readonly local: boolean;
  readonly serverUrl?: string;
  readonly apiKey?: string;
  readonly projectId?: string;
  readonly projectSecret?: string;
  readonly clients?: IMessageClientEntry[];
  readonly phone?: string;

  /** The spectrum-ts instance — null until `initialize()` runs. */
  app: SpectrumInstance | null = null;

  private chat: ChatInstance | null = null;
  private readonly logger: Logger;
  private readonly formatConverter = new iMessageFormatConverter();
  private readonly cache = new InboundCache();
  private readonly modals = new ModalPollRegistry();

  private gatewayOptions?: WebhookOptions;
  private pump: MessagePump | null = null;

  constructor(config: iMessageAdapterConfig) {
    if (config.local && process.platform !== "darwin") {
      throw new ValidationError(
        "imessage",
        "iMessage adapter local mode requires macOS. Current platform: " +
          process.platform
      );
    }

    this.local = config.local;
    this.logger = config.logger;
    this.serverUrl = config.serverUrl;
    this.apiKey = config.apiKey;

    if (!config.local) {
      this.projectId = config.projectId;
      this.projectSecret = config.projectSecret;
      this.phone = config.phone;
      this.clients = config.clients
        ? Array.isArray(config.clients)
          ? config.clients
          : [config.clients]
        : undefined;
    }
  }

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;

    const { providerConfig, projectId, projectSecret } = resolveSpectrumConfig(
      this.local,
      {
        apiKey: this.apiKey,
        clients: this.clients,
        phone: this.phone,
        projectId: this.projectId,
        projectSecret: this.projectSecret,
        serverUrl: this.serverUrl,
      }
    );
    const providers = [imessage.config(providerConfig)];

    this.app =
      projectId && projectSecret
        ? await Spectrum({ providers, projectId, projectSecret })
        : await Spectrum({ providers });

    this.pump = new MessagePump(
      () => {
        if (!this.app) {
          throw new Error("Adapter not initialized");
        }
        return this.app.messages;
      },
      (space, message) =>
        this.routeInbound(space, message, this.gatewayOptions),
      this.logger
    );

    this.logger.info("iMessage adapter initialized", {
      local: this.local,
      mode: this.local ? "local" : projectId ? "cloud" : "self-host",
    });
  }

  async handleWebhook(
    _request: Request,
    _options?: WebhookOptions
  ): Promise<Response> {
    // The iMessage provider is not webhook (fusor) based — receive messages
    // via startGatewayListener() instead.
    return new Response("Webhook not supported -- use startGatewayListener()", {
      status: 501,
    });
  }

  async postMessage(
    threadId: string,
    message: AdapterPostableMessage
  ): Promise<RawMessage> {
    const space = this.requireSpace(threadId, "postMessage");
    const body = this.formatConverter.renderPostable(message);
    const files = extractFiles(message);

    let first: SpectrumMessage | undefined;
    if (body && body.trim().length > 0) {
      first = (await space.send(textContent(body))) ?? first;
    }
    for (const file of files) {
      const sent = (await space.send(await fileToAttachment(file))) ?? undefined;
      first ??= sent;
    }

    return { id: first?.id ?? `msg-${Date.now()}`, threadId, raw: first };
  }

  async editMessage(
    threadId: string,
    messageId: string,
    message: AdapterPostableMessage
  ): Promise<RawMessage> {
    if (this.local) {
      throw new NotImplementedError(
        "editMessage is not supported in local mode",
        "editMessage"
      );
    }

    const target = await this.resolveMessage(threadId, messageId);
    if (!target) {
      throw new NotImplementedError(
        "editMessage requires the original message to have been received in this session",
        "editMessage"
      );
    }

    await target.edit(textContent(this.formatConverter.renderPostable(message)));
    return { id: messageId, threadId, raw: target };
  }

  async deleteMessage(_threadId: string, _messageId: string): Promise<void> {
    throw new NotImplementedError(
      "deleteMessage is not implemented",
      "deleteMessage"
    );
  }

  parseMessage(raw: unknown): Message {
    const message = raw as SpectrumMessage;
    return buildChatMessage(message, message.space);
  }

  async fetchMessages(
    _threadId: string,
    _options?: FetchOptions
  ): Promise<FetchResult> {
    throw new NotImplementedError(
      "fetchMessages (message history) is not supported by spectrum-ts",
      "fetchMessages"
    );
  }

  async fetchThread(_threadId: string): Promise<ThreadInfo> {
    throw new NotImplementedError(
      "fetchThread (chat info) is not supported by spectrum-ts",
      "fetchThread"
    );
  }

  async addReaction(
    threadId: string,
    messageId: string,
    emoji: EmojiValue | string
  ): Promise<void> {
    if (this.local) {
      throw new NotImplementedError(
        "addReaction is not supported in local mode",
        "addReaction"
      );
    }

    const glyph = emojiToGlyph(emoji);
    const target = await this.resolveMessage(threadId, messageId);
    if (!target) {
      throw new NotImplementedError(
        "addReaction requires the target message to have been received in this session",
        "addReaction"
      );
    }

    await target.react(glyph);
  }

  async removeReaction(
    _threadId: string,
    _messageId: string,
    _emoji: EmojiValue | string
  ): Promise<void> {
    throw new NotImplementedError(
      "removeReaction is not supported (spectrum-ts has no reaction-removal API)",
      "removeReaction"
    );
  }

  async startTyping(threadId: string, _status?: string): Promise<void> {
    if (this.local) {
      throw new NotImplementedError(
        "startTyping is not supported in local mode",
        "startTyping"
      );
    }

    const space = this.requireSpace(threadId, "startTyping");
    await space.startTyping();
    setTimeout(() => {
      void space.stopTyping().catch(() => {});
    }, TYPING_DURATION_MS);
  }

  async openModal(
    triggerId: string,
    modal: ModalElement,
    contextId?: string
  ): Promise<{ viewId: string }> {
    if (this.local) {
      throw new NotImplementedError(
        "openModal is not supported in local mode",
        "openModal"
      );
    }

    const select = modal.children.find(
      (c): c is SelectElement => c.type === "select"
    );
    if (!select) {
      throw new ValidationError(
        "imessage",
        "openModal requires at least one Select child — iMessage modals map to native polls"
      );
    }

    const labels = select.options.map((o) => o.label);
    if (labels.length < 2 || labels.length > 10) {
      throw new ValidationError(
        "imessage",
        `iMessage polls require between 2 and 10 options, received ${labels.length}`
      );
    }

    const { chatGuid } = decodeThreadId(triggerId);
    const space = this.requireSpace(triggerId, "openModal");

    const sent = await space.send(pollContent(modal.title, labels));
    const viewId = sent?.id ?? `poll-${Date.now()}`;

    this.modals.register(chatGuid, modal.title, {
      viewId,
      callbackId: modal.callbackId,
      selectId: select.id,
      options: select.options,
      contextId,
      privateMetadata: modal.privateMetadata,
    });

    return { viewId };
  }

  renderFormatted(content: FormattedContent): string {
    return this.formatConverter.fromAst(content);
  }

  encodeThreadId(platformData: iMessageThreadId): string {
    return encodeThreadId(platformData);
  }

  decodeThreadId(threadId: string): iMessageThreadId {
    return decodeThreadId(threadId);
  }

  isDM(threadId: string): boolean {
    return isDMChatGuid(decodeThreadId(threadId).chatGuid);
  }

  async startGatewayListener(
    options: WebhookOptions,
    durationMs = 180000,
    abortSignal?: AbortSignal
  ): Promise<Response> {
    if (!this.chat) {
      return new Response("Chat instance not initialized", { status: 500 });
    }
    if (!options.waitUntil) {
      return new Response("waitUntil not provided", { status: 500 });
    }
    if (!this.app || !this.pump) {
      return new Response("Adapter not initialized", { status: 500 });
    }

    this.logger.info("Starting iMessage Gateway listener", {
      durationMs,
      mode: this.local ? "local" : "remote",
    });

    this.gatewayOptions = options;
    this.pump.ensureRunning();

    const listenerPromise = new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, durationMs);
      if (abortSignal) {
        const onAbort = () => {
          this.logger.info("iMessage Gateway listener received abort signal");
          clearTimeout(timeout);
          this.pump?.stop();
          resolve();
        };
        if (abortSignal.aborted) {
          onAbort();
          return;
        }
        abortSignal.addEventListener("abort", onAbort, { once: true });
      }
    });
    options.waitUntil(listenerPromise);

    return new Response(
      JSON.stringify({
        status: "listening",
        durationMs,
        mode: this.local ? "local" : "remote",
        message: `Gateway listener started, will run for ${durationMs / 1000} seconds`,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  private async routeInbound(
    space: SpectrumSpace,
    message: SpectrumMessage,
    options?: WebhookOptions
  ): Promise<void> {
    if (!this.chat) {
      return;
    }

    this.cache.remember(space, message);

    const contentType = message.content.type;
    if (contentType === "poll_option") {
      this.handlePollOption(space, message, options);
      return;
    }
    if (contentType === "reaction") {
      // Inbound reactions are not surfaced to Chat SDK (parity with the
      // previous adapter, which only forwarded text/attachment messages).
      return;
    }
    if (message.direction === "outbound") {
      return;
    }

    const chatMessage = buildChatMessage(message, space);
    this.chat.processMessage(this, chatMessage.threadId, chatMessage, options);
  }

  private handlePollOption(
    space: SpectrumSpace,
    message: SpectrumMessage,
    options?: WebhookOptions
  ): void {
    if (!this.chat) {
      return;
    }
    const content = message.content;
    if (content.type !== "poll_option") {
      return;
    }
    // Only count a cast vote, not a deselection.
    if (!content.selected) {
      return;
    }

    const resolved = this.modals.resolveVote(
      space.id,
      content.poll.title,
      content.option.title
    );
    if (!resolved) {
      this.logger.debug("Poll vote for unknown poll, skipping", {
        title: content.poll.title,
      });
      return;
    }

    const { meta, value } = resolved;
    const handle = message.sender?.id ?? "";

    this.chat.processModalSubmit(
      {
        adapter: this,
        callbackId: meta.callbackId,
        privateMetadata: meta.privateMetadata,
        viewId: meta.viewId,
        user: {
          userId: handle,
          userName: handle,
          fullName: handle,
          isBot: false,
          isMe: false,
        },
        values: { [meta.selectId]: value },
        raw: message,
      },
      meta.contextId,
      options
    );
  }

  private requireSpace(threadId: string, action: string): SpectrumSpace {
    const { chatGuid } = decodeThreadId(threadId);
    const space = this.cache.getSpace(chatGuid);
    if (!space) {
      throw new NotImplementedError(
        `${action} requires a thread that was received in this session; ` +
          "spectrum-ts cannot construct a Space from a chatGuid (no proactive/cold sends). " +
          "Respond within a received message's thread instead.",
        action
      );
    }
    return space;
  }

  private async resolveMessage(
    threadId: string,
    messageId: string
  ): Promise<SpectrumMessage | undefined> {
    const cached = this.cache.getMessage(messageId);
    if (cached) {
      return cached;
    }
    const { chatGuid } = decodeThreadId(threadId);
    const space = this.cache.getSpace(chatGuid);
    if (!space) {
      return undefined;
    }
    return (await space.getMessage(messageId)) ?? undefined;
  }
}
