import { extractFiles, ValidationError } from "@chat-adapter/shared";
import type {
  Adapter,
  AdapterPostableMessage,
  ChatInstance,
  EmojiValue,
  FetchOptions,
  FetchResult,
  FileUpload,
  FormattedContent,
  Logger,
  ModalElement,
  RawMessage,
  SelectElement,
  ThreadInfo,
  WebhookOptions,
} from "chat";
import { ConsoleLogger, Message, NotImplementedError, parseMarkdown } from "chat";
import {
  attachment as attachmentContent,
  type Content as SpectrumContent,
  poll as pollContent,
  Spectrum,
  type SpectrumInstance,
  type Message as SpectrumMessage,
  type Space as SpectrumSpace,
  text as textContent,
} from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { iMessageFormatConverter } from "./markdown";
import type {
  IMessageClientEntry,
  iMessageThreadId,
  ModalPollMeta,
} from "./types";

export { iMessageFormatConverter } from "./markdown";
export type { IMessageClientEntry, iMessageThreadId } from "./types";

/** Provider config shape accepted by `imessage.config(...)`. */
type IMessageProviderConfig =
  | { local: true }
  | { clients?: IMessageClientEntry[]; local?: false };

const SHARED_PHONE = "shared";

export interface iMessageAdapterLocalConfig {
  /** Unused in local mode; accepted for symmetry/back-compat. */
  apiKey?: string;
  local: true;
  logger: Logger;
  /** Unused in local mode; accepted for symmetry/back-compat. */
  serverUrl?: string;
}

export interface iMessageAdapterRemoteConfig {
  /** Legacy self-host token. Mapped to a `clients` entry's `token`. */
  apiKey?: string;
  /** Explicit self-host gRPC clients (advanced). */
  clients?: IMessageClientEntry | IMessageClientEntry[];
  local: false;
  logger: Logger;
  /** Routing/identity phone for legacy self-host (defaults to `"shared"`). */
  phone?: string;
  /** Spectrum Cloud project id (recommended remote path). */
  projectId?: string;
  /** Spectrum Cloud project secret (recommended remote path). */
  projectSecret?: string;
  /** Legacy self-host endpoint. Now a gRPC `host:port` (see README). */
  serverUrl?: string;
}

export type iMessageAdapterConfig =
  | iMessageAdapterLocalConfig
  | iMessageAdapterRemoteConfig;

export interface CreateiMessageAdapterOptions {
  apiKey?: string;
  clients?: IMessageClientEntry | IMessageClientEntry[];
  local?: boolean;
  logger?: Logger;
  phone?: string;
  projectId?: string;
  projectSecret?: string;
  serverUrl?: string;
}

/**
 * Normalize a legacy `serverUrl` into a gRPC `host:port` address.
 *
 * `@photon-ai/advanced-imessage` (the transport spectrum-ts uses) speaks gRPC,
 * not HTTP/Socket.IO, so any scheme is stripped and a default `:443` port is
 * appended when none is present.
 */
export function deriveAddress(serverUrl: string): string {
  const stripped = serverUrl
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/\/.*$/, "");
  return stripped.includes(":") ? stripped : `${stripped}:443`;
}

const MAX_CACHED_SPACES = 256;
const MAX_CACHED_MESSAGES = 1024;
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

  /** chatGuid -> last-seen Space (for stateless threadId-addressed sends). */
  private readonly spaceCache = new Map<string, SpectrumSpace>();
  /** messageId -> last-seen Message (for react/edit by id). */
  private readonly messageCache = new Map<string, SpectrumMessage>();
  /** poll viewId -> modal bookkeeping. */
  private readonly modalPollMap = new Map<string, ModalPollMeta>();
  /** `${chatGuid}::${pollTitle}` -> modal bookkeeping (vote routing). */
  private readonly modalPollByTitle = new Map<string, ModalPollMeta>();

  private gatewayOptions?: WebhookOptions;
  private pumpStarted = false;
  private pumpIterator: AsyncIterator<[SpectrumSpace, SpectrumMessage]> | null =
    null;

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

    const { providerConfig, projectId, projectSecret } =
      this.buildSpectrumConfig();
    const providers = [imessage.config(providerConfig)];

    this.app =
      projectId && projectSecret
        ? await Spectrum({ providers, projectId, projectSecret })
        : await Spectrum({ providers });

    this.logger.info("iMessage adapter initialized", {
      local: this.local,
      mode: this.local ? "local" : projectId ? "cloud" : "self-host",
    });
  }

  private buildSpectrumConfig(): {
    projectId?: string;
    projectSecret?: string;
    providerConfig: IMessageProviderConfig;
  } {
    if (this.local) {
      return { providerConfig: { local: true } };
    }
    if (this.projectId && this.projectSecret) {
      return {
        providerConfig: {},
        projectId: this.projectId,
        projectSecret: this.projectSecret,
      };
    }
    if (this.clients?.length) {
      return { providerConfig: { clients: this.clients } };
    }
    if (this.serverUrl && this.apiKey) {
      return {
        providerConfig: {
          clients: [
            {
              address: deriveAddress(this.serverUrl),
              token: this.apiKey,
              phone: this.phone ?? SHARED_PHONE,
            },
          ],
        },
      };
    }
    throw new ValidationError(
      "imessage",
      "Remote mode requires Spectrum Cloud credentials (projectId + projectSecret), explicit clients, or serverUrl + apiKey."
    );
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
      const built = await this.toAttachment(file);
      const sent = (await space.send(built)) ?? undefined;
      first ??= sent;
    }

    return {
      id: first?.id ?? `msg-${Date.now()}`,
      threadId,
      raw: first,
    };
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

    const body = this.formatConverter.renderPostable(message);
    await target.edit(textContent(body));

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
    return this.buildFromSpectrum(message, message.space);
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

    const glyph = this.emojiToGlyph(emoji);
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

    const { chatGuid } = this.decodeThreadId(triggerId);
    const space = this.requireSpace(triggerId, "openModal");

    const sent = await space.send(pollContent(modal.title, labels));
    const viewId = sent?.id ?? `poll-${Date.now()}`;

    const meta: ModalPollMeta = {
      viewId,
      callbackId: modal.callbackId,
      selectId: select.id,
      options: select.options,
      contextId,
      privateMetadata: modal.privateMetadata,
    };
    this.modalPollMap.set(viewId, meta);
    this.modalPollByTitle.set(this.pollKey(chatGuid, modal.title), meta);

    return { viewId };
  }

  renderFormatted(content: FormattedContent): string {
    return this.formatConverter.fromAst(content);
  }

  encodeThreadId(platformData: iMessageThreadId): string {
    return `imessage:${platformData.chatGuid}`;
  }

  decodeThreadId(threadId: string): iMessageThreadId {
    if (!threadId.startsWith("imessage:")) {
      throw new ValidationError(
        "imessage",
        `Invalid iMessage thread ID: ${threadId}`
      );
    }
    return { chatGuid: threadId.slice("imessage:".length) };
  }

  isDM(threadId: string): boolean {
    const { chatGuid } = this.decodeThreadId(threadId);
    return chatGuid.includes(";-;");
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
    if (!this.app) {
      return new Response("Adapter not initialized", { status: 500 });
    }

    this.logger.info("Starting iMessage Gateway listener", {
      durationMs,
      mode: this.local ? "local" : "remote",
    });

    this.gatewayOptions = options;
    this.ensurePump();

    const listenerPromise = new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, durationMs);
      if (abortSignal) {
        const onAbort = () => {
          this.logger.info("iMessage Gateway listener received abort signal");
          clearTimeout(timeout);
          this.stopPump();
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

  /**
   * Start the single, long-lived consumer of `app.messages`. One persistent
   * pump (rather than a fresh subscription per gateway call) avoids dropping
   * an in-flight message on timeout and keeps the connection warm across
   * overlapping cron windows. Idempotent.
   */
  private ensurePump(): void {
    if (this.pumpStarted || !this.app) {
      return;
    }
    this.pumpStarted = true;

    const iterator = this.app.messages[Symbol.asyncIterator]();
    this.pumpIterator = iterator;

    void (async () => {
      try {
        while (true) {
          const next = await iterator.next();
          if (next.done) {
            break;
          }
          const [space, message] = next.value;
          try {
            await this.routeInbound(space, message, this.gatewayOptions);
          } catch (error) {
            this.logger.error("iMessage inbound handler error", {
              error: String(error),
            });
          }
        }
      } catch (error) {
        this.logger.error("iMessage message stream error", {
          error: String(error),
        });
      } finally {
        this.logger.info("iMessage Gateway listener stopped");
      }
    })();
  }

  private stopPump(): void {
    const iterator = this.pumpIterator;
    this.pumpIterator = null;
    this.pumpStarted = false;
    if (iterator?.return) {
      void iterator.return();
    }
  }

  private async routeInbound(
    space: SpectrumSpace,
    message: SpectrumMessage,
    options?: WebhookOptions
  ): Promise<void> {
    if (!this.chat) {
      return;
    }

    this.cacheInbound(space, message);

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

    const chatMessage = this.buildFromSpectrum(message, space);
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

    const meta = this.modalPollByTitle.get(
      this.pollKey(space.id, content.poll.title)
    );
    if (!meta) {
      this.logger.debug("Poll vote for unknown poll, skipping", {
        title: content.poll.title,
      });
      return;
    }

    const optionIndex = meta.options.findIndex(
      (o) => o.label === content.option.title
    );
    const value =
      optionIndex >= 0 ? meta.options[optionIndex].value : content.option.title;
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

  private buildFromSpectrum(
    message: SpectrumMessage,
    space: SpectrumSpace
  ): Message {
    const chatGuid = space.id;
    const threadId = this.encodeThreadId({ chatGuid });
    const text = this.extractText(message.content);
    const sender = message.sender?.id ?? "";
    const isDM = chatGuid.includes(";-;");

    return new Message({
      id: message.id,
      threadId,
      text,
      formatted: parseMarkdown(text),
      author: {
        userId: sender,
        userName: sender,
        fullName: sender,
        isBot: false,
        isMe: message.direction === "outbound",
      },
      metadata: {
        dateSent: message.timestamp,
        edited: false,
      },
      attachments: this.extractAttachments(message.content).map((a) => ({
        type: this.getAttachmentType(a.mimeType),
        name: a.name,
        mimeType: a.mimeType,
        size: a.size ?? 0,
      })),
      raw: message,
      isMention: isDM,
    });
  }

  private extractText(content: SpectrumContent): string {
    switch (content.type) {
      case "text":
        return content.text;
      case "richlink":
        return String(content.url);
      case "poll":
        return content.title;
      case "group":
        return content.items
          .map((item) => this.extractText(item.content))
          .filter((t) => t.length > 0)
          .join("\n");
      default:
        return "";
    }
  }

  private extractAttachments(
    content: SpectrumContent
  ): Array<{ mimeType: string; name: string; size?: number }> {
    const out: Array<{ mimeType: string; name: string; size?: number }> = [];
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

  private cacheInbound(space: SpectrumSpace, message: SpectrumMessage): void {
    this.spaceCache.set(space.id, space);
    this.evict(this.spaceCache, MAX_CACHED_SPACES);

    this.cacheMessage(message);
    if (message.content.type === "group") {
      for (const item of message.content.items) {
        this.cacheMessage(item);
      }
    }
  }

  private cacheMessage(message: SpectrumMessage): void {
    this.messageCache.set(message.id, message);
    this.evict(this.messageCache, MAX_CACHED_MESSAGES);
  }

  private evict(map: Map<string, unknown>, max: number): void {
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

  private requireSpace(threadId: string, action: string): SpectrumSpace {
    const { chatGuid } = this.decodeThreadId(threadId);
    const space = this.spaceCache.get(chatGuid);
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
    const cached = this.messageCache.get(messageId);
    if (cached) {
      return cached;
    }
    const { chatGuid } = this.decodeThreadId(threadId);
    const space = this.spaceCache.get(chatGuid);
    if (!space) {
      return undefined;
    }
    return (await space.getMessage(messageId)) ?? undefined;
  }

  private async toAttachment(file: FileUpload) {
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
    // `attachment(buffer, …)` derives MIME from `name`'s extension and throws
    // if it can't — pass an explicit type, or fall back when there's no
    // extension to resolve from.
    const options = mimeType
      ? { name, mimeType }
      : name.includes(".")
        ? { name }
        : { name, mimeType: "application/octet-stream" };

    return attachmentContent(buffer, options);
  }

  private pollKey(chatGuid: string, title: string): string {
    return `${chatGuid}::${title}`;
  }

  private emojiToGlyph(emoji: EmojiValue | string): string {
    const name = typeof emoji === "string" ? emoji : emoji.name;
    const glyphMap: Record<string, string> = {
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
    const glyph = glyphMap[name];
    if (!glyph) {
      throw new ValidationError(
        "imessage",
        `Unsupported iMessage tapback: "${name}". Supported: heart, thumbs_up, thumbs_down, laugh, emphasize, question`
      );
    }
    return glyph;
  }

  private getAttachmentType(
    mimeType?: string
  ): "image" | "video" | "audio" | "file" {
    if (!mimeType) return "file";
    if (mimeType.startsWith("image/")) return "image";
    if (mimeType.startsWith("video/")) return "video";
    if (mimeType.startsWith("audio/")) return "audio";
    return "file";
  }
}

export function createiMessageAdapter(
  config?: CreateiMessageAdapterOptions
): iMessageAdapter {
  const local = config?.local ?? process.env.IMESSAGE_LOCAL !== "false";
  const logger = config?.logger ?? new ConsoleLogger("info").child("imessage");

  if (local) {
    return new iMessageAdapter({
      local: true,
      logger,
      serverUrl: config?.serverUrl ?? process.env.IMESSAGE_SERVER_URL,
      apiKey: config?.apiKey ?? process.env.IMESSAGE_API_KEY,
    });
  }

  const projectId = config?.projectId ?? process.env.IMESSAGE_PROJECT_ID;
  const projectSecret =
    config?.projectSecret ?? process.env.IMESSAGE_PROJECT_SECRET;
  const clients = config?.clients;
  const serverUrl = config?.serverUrl ?? process.env.IMESSAGE_SERVER_URL;
  const apiKey = config?.apiKey ?? process.env.IMESSAGE_API_KEY;
  const phone = config?.phone ?? process.env.IMESSAGE_PHONE;

  const hasCloud = Boolean(projectId && projectSecret);
  const hasClients = Boolean(clients);

  if (!hasCloud && !hasClients) {
    if (!serverUrl) {
      throw new ValidationError(
        "imessage",
        "serverUrl is required when local is false. Set IMESSAGE_SERVER_URL (or use IMESSAGE_PROJECT_ID/IMESSAGE_PROJECT_SECRET for Spectrum Cloud), or provide it in config."
      );
    }
    if (!apiKey) {
      throw new ValidationError(
        "imessage",
        "apiKey is required when local is false. Set IMESSAGE_API_KEY or provide it in config."
      );
    }
  }

  return new iMessageAdapter({
    local: false,
    logger,
    projectId,
    projectSecret,
    clients,
    serverUrl,
    apiKey,
    phone,
  });
}
