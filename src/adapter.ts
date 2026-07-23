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
  type AppUrl,
  app as appContent,
  type ContentBuilder,
  markdown as markdownContent,
  poll as pollContent,
  Spectrum,
  type SpectrumInstance,
  type Message as SpectrumMessage,
  type Space as SpectrumSpace,
  text as textContent,
} from "@spectrum-ts/core";
import {
  customizedMiniApp,
  effect as effectContent,
  imessage,
} from "@spectrum-ts/imessage";
import {
  type BackgroundInput,
  type BackgroundOptions,
  resolveBackground,
} from "./background";
import { type iMessageAdapterConfig, resolveSpectrumConfig } from "./config";
import {
  type IMessageMessageEffect,
  type iMessageEffectName,
  resolveEffect,
} from "./effects";
import { InboundCache } from "./internal/cache";
import { MessagePump } from "./internal/gateway";
import { buildChatMessage } from "./internal/inbound";
import { ModalPollRegistry } from "./internal/modals";
import { emojiToGlyph, fileToAttachment } from "./internal/outbound";
import {
  decodeThreadId,
  encodeThreadId,
  isDMChatGuid,
} from "./internal/thread";
import {
  buildChatMessageFromWebhook,
  SPECTRUM_EVENT_HEADER,
  SPECTRUM_MESSAGES_EVENT,
  SPECTRUM_SIGNATURE_HEADER,
  SPECTRUM_TIMESTAMP_HEADER,
  type SpectrumWebhookPayload,
  verifySpectrumSignature,
} from "./internal/webhook";
import { iMessageFormatConverter } from "./markdown";
import { isAppUrl, type MiniAppCard, resolveMiniApp } from "./miniapp";
import type { IMessageClientEntry, iMessageThreadId } from "./types";
import { resolveVoice, type VoiceInput, type VoiceOptions } from "./voice";

const TYPING_DURATION_MS = 3000;

/**
 * Content types that describe conversation events, not user messages.
 * spectrum-ts v9+ surfaces group membership changes, renames, and avatar
 * updates on `app.messages` (and in webhook deliveries) as inbound messages;
 * forwarding them to the Chat SDK would surface phantom empty-text messages.
 */
const EVENT_CONTENT_TYPES = new Set([
  "addMember",
  "removeMember",
  "leaveSpace",
  "rename",
  "avatar",
  "typing",
]);

export class iMessageAdapter implements Adapter {
  readonly name = "imessage";
  readonly userName: string = "";
  readonly serverUrl?: string;
  readonly apiKey?: string;
  readonly projectId?: string;
  readonly projectSecret?: string;
  readonly clients?: IMessageClientEntry[];
  readonly credentials?: iMessageAdapterConfig["credentials"];
  readonly phone?: string;
  readonly webhookSecret?: string;

  /** The spectrum-ts instance — null until `initialize()` or `ensureApp()` runs. */
  app: SpectrumInstance | null = null;
  /** In-flight app build, so concurrent callers share one construction. */
  private appBuild: Promise<void> | null = null;

  private chat: ChatInstance | null = null;
  private readonly logger: Logger;
  private readonly formatConverter = new iMessageFormatConverter();
  private readonly cache = new InboundCache();
  private readonly modals = new ModalPollRegistry();

  private gatewayOptions?: WebhookOptions;
  private pump: MessagePump | null = null;

  constructor(config: iMessageAdapterConfig) {
    // fail loudly instead of silently running in remote mode.
    if (config.local) {
      throw new ValidationError(
        "imessage",
        "Local (on-device) mode was removed from this adapter. Use Spectrum Cloud (projectId + projectSecret) or a self-hosted gRPC endpoint instead."
      );
    }

    this.logger = config.logger;
    this.credentials = config.credentials;
    this.serverUrl = config.serverUrl;
    this.apiKey = config.apiKey;
    this.projectId = config.projectId;
    this.projectSecret = config.projectSecret;
    this.phone = config.phone;
    this.clients = toClientArray(config.clients);
    // Trim here too so direct `new iMessageAdapter(...)` matches the factory
    // (createiMessageAdapter trims it): a stray space would otherwise fail
    // signature verification only on the constructor path.
    this.webhookSecret = config.webhookSecret?.trim();
  }

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
    await this.ensureApp();

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
  }

  /**
   * Build the spectrum-ts app on demand. eve may call the adapter in an
   * invocation that never ran `initialize()` (e.g. a Vercel Workflow reply
   * callback), leaving `this.app` null — every send funnels through here first.
   */
  private async ensureApp(): Promise<void> {
    if (this.app) {
      return;
    }
    this.appBuild ??= this.buildApp().catch((error) => {
      this.appBuild = null;
      throw error;
    });
    await this.appBuild;
  }

  private async buildApp(): Promise<void> {
    const credentials = await this.credentials?.();
    const { providerConfig, projectId, projectSecret } = resolveSpectrumConfig({
      apiKey: this.apiKey,
      clients: this.clients,
      phone: this.phone,
      projectId: credentials?.projectId ?? this.projectId,
      projectSecret: credentials?.projectSecret ?? this.projectSecret,
      serverUrl: this.serverUrl,
    });
    const providers = [imessage.config(providerConfig)];

    this.app =
      projectId && projectSecret
        ? await Spectrum({ providers, projectId, projectSecret })
        : await Spectrum({ providers });

    this.logger.info("iMessage adapter initialized", {
      mode: projectId ? "cloud" : "self-host",
    });
  }

  /**
   * Handle a Spectrum Cloud webhook delivery (signed JSON `messages` event).
   *
   * Verifies the `X-Spectrum-Signature` HMAC, then routes the message into the
   * Chat SDK. A delivered thread has no live spectrum-ts `Space`, but the
   * adapter rebuilds one from the chat GUID on demand (see `resolveSpace`), so
   * replying works directly from a webhook delivery.
   *
   * @see https://photon.codes/docs/webhooks/overview
   */
  async handleWebhook(
    request: Request,
    options?: WebhookOptions
  ): Promise<Response> {
    if (!this.chat) {
      return new Response("Chat instance not initialized", { status: 500 });
    }
    if (!this.webhookSecret) {
      return new Response(
        "Webhook signing secret not configured (set IMESSAGE_WEBHOOK_SECRET)",
        { status: 500 }
      );
    }

    // Read the raw body BEFORE parsing: the signature covers the exact bytes.
    const rawBody = await request.text();
    const verdict = verifySpectrumSignature({
      secret: this.webhookSecret,
      signature: request.headers.get(SPECTRUM_SIGNATURE_HEADER),
      timestamp: request.headers.get(SPECTRUM_TIMESTAMP_HEADER),
      rawBody,
    });
    if (!verdict.ok) {
      this.logger.warn("Rejected iMessage webhook delivery", {
        reason: verdict.reason,
      });
      return new Response(verdict.reason, { status: verdict.status });
    }

    const event = request.headers.get(SPECTRUM_EVENT_HEADER);
    if (event && event !== SPECTRUM_MESSAGES_EVENT) {
      // Acknowledge unrecognized event types so Cloud does not retry them.
      return new Response(null, { status: 204 });
    }

    let payload: SpectrumWebhookPayload;
    try {
      payload = JSON.parse(rawBody) as SpectrumWebhookPayload;
    } catch {
      return new Response("Invalid JSON body", { status: 400 });
    }

    if (
      payload.event !== SPECTRUM_MESSAGES_EVENT ||
      !(payload.message && payload.space)
    ) {
      return new Response(null, { status: 204 });
    }

    this.routeWebhookMessage(payload, options);
    return new Response(null, { status: 200 });
  }

  /**
   * Build the spectrum content for an outbound message. Markdown-typed inputs
   * are sent via `markdown()` so remote iMessage renders them as native styled
   * text; raw/string/card inputs stay plain `text()`. Returns the rendered
   * `body` too so callers can skip an empty send.
   */
  private toSpectrumContent(message: AdapterPostableMessage): {
    body: string;
    content: ContentBuilder;
  } {
    const { body, markdown } =
      this.formatConverter.renderPostableContent(message);
    return {
      body,
      content: markdown ? markdownContent(body) : textContent(body),
    };
  }

  async postMessage(
    threadId: string,
    message: AdapterPostableMessage
  ): Promise<RawMessage> {
    const space = await this.requireSpace(threadId, "postMessage");
    const { body, content } = this.toSpectrumContent(message);
    const files = extractFiles(message);

    let first: SpectrumMessage | undefined;
    if (body && body.trim().length > 0) {
      first = (await space.send(content)) ?? first;
    }
    for (const file of files) {
      const sent =
        (await space.send(await fileToAttachment(file))) ?? undefined;
      first ??= sent;
    }

    if (!first) {
      throw new ValidationError(
        "imessage",
        "postMessage requires non-empty text or at least one attachment"
      );
    }

    return { id: first.id, threadId, raw: first };
  }

  /**
   * Send a message with an iMessage expressive-send effect — a bubble effect
   * (`slam`, `loud`, `gentle`, `invisible`) or a full-screen effect
   * (`confetti`, `fireworks`, `balloons`, `heart`, `lasers`, `celebration`,
   * `sparkles`, `spotlight`, `echo`). Not part of the Chat SDK `Adapter`
   * interface — exposed as an adapter-specific extra (e.g. celebratory confetti
   * on task completion).
   *
   * The `effect` argument accepts a friendly name (`"confetti"`) or a value from
   * the re-exported `iMessageEffect` map. Effects attach to text content only,
   * so this requires non-empty text.
   */
  async sendEffect(
    threadId: string,
    message: AdapterPostableMessage,
    effect: IMessageMessageEffect | iMessageEffectName
  ): Promise<RawMessage> {
    const space = await this.requireSpace(threadId, "sendEffect");
    const { body, content } = this.toSpectrumContent(message);
    if (!body || body.trim().length === 0) {
      throw new ValidationError(
        "imessage",
        "sendEffect requires non-empty text content"
      );
    }

    const effectId = resolveEffect(effect);
    const sent = await space.send(effectContent(content, effectId));
    if (!sent) {
      throw new ValidationError(
        "imessage",
        "sendEffect could not send the message"
      );
    }

    return { id: sent.id, threadId, raw: sent };
  }

  /**
   * Send an iMessage mini-app card — an `MSMessageExtension` balloon, the
   * closest iMessage gets to a rich card (à la Slack Block Kit) instead of a
   * bare link. Not part of the Chat SDK `Adapter` interface — exposed as an
   * adapter-specific extra.
   *
   * Two forms:
   *
   * - **Just a URL** — pass a string (or a `Promise`/thunk resolving to one, so
   *   the link can be minted at send time). This is the lightweight `app(url)`
   *   card: the URL is rendered as a mini-app with no extension identifiers
   *   required.
   * - **A full {@link MiniAppCard}** — pass an object to control the bubble's
   *   image, captions, and the exact iMessage extension that opens on tap. Its
   *   `appName`, `teamId`, and `extensionBundleId` identify that extension.
   */
  async sendMiniApp(threadId: string, url: AppUrl): Promise<RawMessage>;
  async sendMiniApp(threadId: string, card: MiniAppCard): Promise<RawMessage>;
  async sendMiniApp(
    threadId: string,
    input: MiniAppCard | AppUrl
  ): Promise<RawMessage> {
    const space = await this.requireSpace(threadId, "sendMiniApp");
    const content = isAppUrl(input)
      ? appContent(input)
      : customizedMiniApp(await resolveMiniApp(input));
    const sent = await space.send(content);
    if (!sent) {
      throw new ValidationError(
        "imessage",
        "sendMiniApp could not send the card"
      );
    }

    return { id: sent.id, threadId, raw: sent };
  }

  /**
   * Send a native iMessage voice note — a real, playable waveform bubble (the
   * message renders with `isAudioMessage`), not an audio file dropped in as an
   * attachment. A natural fit for TTS-capable bots that reply with speech. Not
   * part of the Chat SDK `Adapter` interface — exposed as an adapter-specific
   * extra.
   *
   * The `input` is either in-memory audio bytes (`Uint8Array` / `Buffer` /
   * `ArrayBuffer`, a `Blob`, or a Chat SDK `FileUpload`) or an `http(s)` URL (a
   * `URL` or a string) that is fetched at send time. Audio bytes need an
   * `audio/*` MIME type — supply `options.mimeType` (e.g. `"audio/mp4"`) or an
   * `options.name` with an audio extension when it can't be inferred.
   */
  async sendVoice(
    threadId: string,
    input: VoiceInput,
    options?: VoiceOptions
  ): Promise<RawMessage> {
    const space = await this.requireSpace(threadId, "sendVoice");
    const content = await resolveVoice(input, options);
    const sent = await space.send(content);
    if (!sent) {
      throw new ValidationError(
        "imessage",
        "sendVoice could not send the voice message"
      );
    }

    return { id: sent.id, threadId, raw: sent };
  }

  /**
   * Set or clear the chat background — the wallpaper behind a conversation, an
   * iMessage-only touch with no analog on the plain-text competitors. Not part
   * of the Chat SDK `Adapter` interface — exposed as an adapter-specific extra.
   *
   * The `input` is either the literal `"clear"` (to remove the current
   * background), in-memory image bytes (`Uint8Array` / `Buffer` / `ArrayBuffer`,
   * a `Blob`, or a Chat SDK `FileUpload`), or an `http(s)` URL (a `URL` or a
   * string) that is fetched at send time. Image bytes need an `image/*` MIME
   * type — supply `options.mimeType` (e.g. `"image/jpeg"`) or an `options.name`
   * with an image extension when it can't be inferred.
   *
   * Fire-and-forget: iMessage acknowledges the control signal without returning
   * a message, so this resolves to `void` rather than a {@link RawMessage}.
   */
  async setBackground(
    threadId: string,
    input: BackgroundInput,
    options?: BackgroundOptions
  ): Promise<void> {
    const space = await this.requireSpace(threadId, "setBackground");
    const content = await resolveBackground(input, options);
    await space.send(content);
  }

  async editMessage(
    threadId: string,
    messageId: string,
    message: AdapterPostableMessage
  ): Promise<RawMessage> {
    const target = await this.resolveMessage(threadId, messageId);
    if (!target) {
      throw new NotImplementedError(
        "editMessage requires the original message to have been received in this session",
        "editMessage"
      );
    }

    await target.edit(this.toSpectrumContent(message).content);
    return { id: messageId, threadId, raw: target };
  }

  async deleteMessage(threadId: string, messageId: string): Promise<void> {
    const target = await this.resolveMessage(threadId, messageId);
    if (!target) {
      throw new NotImplementedError(
        "deleteMessage requires the target message to have been sent or received in this session",
        "deleteMessage"
      );
    }

    await target.unsend();
  }

  parseMessage(raw: unknown): Message {
    const message = raw as SpectrumMessage;
    return buildChatMessage(message, message.space);
  }

  /**
   * Fetch a single message by id. spectrum-ts can resolve a message by id
   * (from the inbound cache or the provider's by-id lookup) even though it has
   * no paginated history API, so single-message reads work where
   * `fetchMessages` cannot. Returns `null` when the message can't be resolved.
   */
  async fetchMessage(
    threadId: string,
    messageId: string
  ): Promise<Message | null> {
    const target = await this.resolveMessage(threadId, messageId);
    if (!target) {
      return null;
    }
    return this.parseMessage(target);
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

  channelIdFromThreadId(threadId: string): string {
    return threadId;
  }

  async addReaction(
    threadId: string,
    messageId: string,
    emoji: EmojiValue | string
  ): Promise<void> {
    const glyph = emojiToGlyph(emoji);
    const target = await this.resolveMessage(threadId, messageId);
    if (!target) {
      throw new NotImplementedError(
        "addReaction requires the target message to have been received in this session",
        "addReaction"
      );
    }

    const reaction = await target.react(glyph);
    if (reaction) {
      this.cache.rememberReaction(messageId, glyph, reaction);
    }
  }

  async removeReaction(
    _threadId: string,
    messageId: string,
    emoji: EmojiValue | string
  ): Promise<void> {
    // spectrum-ts message ids are globally unique, so the target message id
    // alone keys the reaction handle — the thread id isn't needed here.
    const glyph = emojiToGlyph(emoji);
    const reaction = this.cache.takeReaction(messageId, glyph);
    if (!reaction) {
      throw new NotImplementedError(
        "removeReaction requires the reaction to have been added via addReaction in this session",
        "removeReaction"
      );
    }

    await reaction.unsend();
  }

  async startTyping(threadId: string, _status?: string): Promise<void> {
    const space = await this.requireSpace(threadId, "startTyping");
    await space.startTyping();
    setTimeout(() => {
      space.stopTyping().catch(() => {
        // best-effort; ignore failures
      });
    }, TYPING_DURATION_MS);
  }

  /**
   * Cold-start a DM with a phone number / handle. spectrum-ts resolves (or
   * creates) the 1:1 conversation from the participant via `space.create`, so
   * the bot can message a user it has never received from. Returns the encoded
   * thread id, ready to pass to `postMessage`.
   */
  async openDM(userId: string): Promise<string> {
    await this.ensureApp();
    if (!this.app) {
      throw new NotImplementedError(
        "openDM requires the adapter to be initialized",
        "openDM"
      );
    }

    const space = await this.platformSpaces().create(userId);
    this.cache.rememberSpace(space);
    return encodeThreadId({
      chatGuid: space.id,
      phone: (space as { phone?: string }).phone,
    });
  }

  /**
   * Mark a received message (and the conversation up to it) as read, surfacing
   * a read receipt where iMessage supports one. Not part of the
   * Chat SDK `Adapter` interface — exposed as an adapter-specific extra.
   */
  async markRead(threadId: string, messageId: string): Promise<void> {
    const target = await this.resolveMessage(threadId, messageId);
    if (!target) {
      throw new NotImplementedError(
        "markRead requires the target message to have been received in this session",
        "markRead"
      );
    }

    await target.read();
  }

  async openModal(
    triggerId: string,
    modal: ModalElement,
    contextId?: string
  ): Promise<{ viewId: string }> {
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
    const space = await this.requireSpace(triggerId, "openModal");

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
    durationMs = 180_000,
    abortSignal?: AbortSignal
  ): Promise<Response> {
    if (!this.chat) {
      return new Response("Chat instance not initialized", { status: 500 });
    }
    if (!options.waitUntil) {
      return new Response("waitUntil not provided", { status: 500 });
    }
    if (!(this.app && this.pump)) {
      return new Response("Adapter not initialized", { status: 500 });
    }

    this.logger.info("Starting iMessage Gateway listener", {
      durationMs,
      mode: "remote",
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
        mode: "remote",
        message: `Gateway listener started, will run for ${durationMs / 1000} seconds`,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  private routeWebhookMessage(
    payload: SpectrumWebhookPayload,
    options?: WebhookOptions
  ): void {
    if (!this.chat) {
      return;
    }

    const { message, space } = payload;
    // No live Space to cache — remember the sending line so a later rebuild
    // picks the right one when several are configured.
    this.cache.rememberPhone(space.id, space.phone ?? message.space?.phone);
    // Parity with the gateway path: surface only inbound text/attachment
    // messages — skip the bot's own echoes and inbound reactions.
    if (message.direction === "outbound") {
      return;
    }
    if (message.content?.type === "reaction") {
      return;
    }
    if (message.content?.type && EVENT_CONTENT_TYPES.has(message.content.type)) {
      return;
    }

    const chatMessage = buildChatMessageFromWebhook(message, space);
    this.chat.processMessage(this, chatMessage.threadId, chatMessage, options);
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
    if (EVENT_CONTENT_TYPES.has(contentType)) {
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
      this.logger.debug("Poll vote did not match a known modal, skipping", {
        title: content.poll.title,
        option: content.option.title,
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

  /**
   * Resolve a sendable spectrum-ts `Space` for a thread. Prefers a cached live
   * Space; otherwise rebuilds it from the chat GUID, passing the sending line
   * so `space.get` can pick it when multiple lines are configured. Returns
   * `undefined` when no Space can be obtained.
   */
  private async resolveSpace(
    threadId: string
  ): Promise<SpectrumSpace | undefined> {
    const { chatGuid, phone: threadPhone } = decodeThreadId(threadId);
    const cached = this.cache.getSpace(chatGuid);
    if (cached) {
      return cached;
    }
    await this.ensureApp();
    if (!this.app) {
      return;
    }
    try {
      // Prefer the line from the thread ID (survives across invocations), then
      // one learned from an inbound delivery in this process.
      const phone = threadPhone ?? this.cache.getPhone(chatGuid);
      const spaces = this.platformSpaces();
      const space = phone
        ? await spaces.get(chatGuid, { phone })
        : await spaces.get(chatGuid);
      this.cache.rememberSpace(space);
      return space;
    } catch (error) {
      this.logger.debug("Could not rebuild Space from chat GUID", {
        chatGuid,
        error: String(error),
      });
      return;
    }
  }

  /**
   * The iMessage provider's Space namespace (`get` / `create`). `HasProvider`
   * over the default provider tuple won't narrow to `true`, so `imessage(app)`
   * types as `never` — cast to the slice of the instance we use.
   */
  private platformSpaces(): {
    get(
      id: string,
      params?: { phone: string }
    ): Promise<SpectrumSpace>;
    create(users: string): Promise<SpectrumSpace>;
  } {
    if (!this.app) {
      throw new Error("Adapter not initialized");
    }
    return (
      imessage(this.app) as unknown as {
        space: {
          get(
            id: string,
            params?: { phone: string }
          ): Promise<SpectrumSpace>;
          create(users: string): Promise<SpectrumSpace>;
        };
      }
    ).space;
  }

  private async requireSpace(
    threadId: string,
    action: string
  ): Promise<SpectrumSpace> {
    const space = await this.resolveSpace(threadId);
    if (!space) {
      throw new NotImplementedError(
        `${action} could not resolve this thread. With multiple iMessage ` +
          "lines configured, spectrum-ts needs the chat's sending line to " +
          "rebuild an unseen thread. Respond within a received message's " +
          "thread instead.",
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
    const space = await this.resolveSpace(threadId);
    if (!space) {
      return;
    }
    return (await space.getMessage(messageId)) ?? undefined;
  }
}

function toClientArray(
  clients: IMessageClientEntry | IMessageClientEntry[] | undefined
): IMessageClientEntry[] | undefined {
  if (!clients) {
    return;
  }
  return Array.isArray(clients) ? clients : [clients];
}
