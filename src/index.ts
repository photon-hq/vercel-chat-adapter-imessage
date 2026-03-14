import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractFiles, ValidationError } from "@chat-adapter/shared";
import type { MessageResponse } from "@photon-ai/advanced-imessage-kit";
import {
  AdvancedIMessageKit,
  isPollVote,
  parsePollVotes,
} from "@photon-ai/advanced-imessage-kit";
import type { Message as IMessageLocalMessage } from "@photon-ai/imessage-kit";
import { IMessageSDK } from "@photon-ai/imessage-kit";
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
  SelectOptionElement,
  ThreadInfo,
  WebhookOptions,
} from "chat";
import { ConsoleLogger, Message, NotImplementedError, parseMarkdown } from "chat";
import { iMessageFormatConverter } from "./markdown";
import {
  metrics,
  trace,
  type MeterProvider,
  type Tracer,
  type TracerProvider,
} from "@opentelemetry/api";
import { logs, type LoggerProvider } from "@opentelemetry/api-logs";
import { DEFAULT_OTEL_CONFIG, type iMessageOTelConfig } from "./telemetry/config";
import {
  ATTR_ERROR_TYPE,
  ATTR_GATEWAY_ABORTED,
  ATTR_GATEWAY_DURATION_MS,
  ATTR_GATEWAY_ERRORS,
  ATTR_GATEWAY_MESSAGES_RECEIVED,
  ATTR_SERVICE_NAME,
  ATTR_IMESSAGE_ATTACHMENT_COUNT,
  ATTR_IMESSAGE_MESSAGE_ID,
  SPAN_ADD_REACTION,
  SPAN_DELETE_MESSAGE,
  SPAN_EDIT_MESSAGE,
  SPAN_FETCH_MESSAGES,
  SPAN_FETCH_THREAD,
  SPAN_FILES_CLEANUP,
  SPAN_FILES_WRITE_TEMP,
  SPAN_GATEWAY_LISTENER,
  SPAN_GATEWAY_RUNNER,
  SPAN_INITIALIZE,
  SPAN_MESSAGE_RECEIVE,
  SPAN_OPEN_MODAL,
  SPAN_POLL_VOTE_RECEIVE,
  SPAN_POST_MESSAGE,
  SPAN_REMOVE_REACTION,
  SPAN_SDK_CONNECT,
  SPAN_SDK_DISCONNECT,
  SPAN_SDK_SEND_ATTACHMENT,
  SPAN_SDK_SEND_MESSAGE,
  SPAN_START_TYPING,
  buildCommonAttributes,
} from "./telemetry/attributes";
import { OTelLogger } from "./telemetry/logger";
import { AdapterMetrics, NOOP_METRICS, createMeter } from "./telemetry/metrics";
import { createTracer, withSpan } from "./telemetry/tracer";
import type { iMessageGatewayMessageData, iMessageThreadId } from "./types";

export { iMessageFormatConverter } from "./markdown";
export type {
  iMessageGatewayMessageData,
  iMessageThreadId,
  NativeWebhookPayload,
} from "./types";
export type { iMessageOTelConfig } from "./telemetry/config";

export interface iMessageAdapterLocalConfig {
  apiKey?: string;
  local: true;
  logger: Logger;
  otel?: iMessageOTelConfig;
  serverUrl?: string;
}

export interface iMessageAdapterRemoteConfig {
  apiKey: string;
  local: false;
  logger: Logger;
  otel?: iMessageOTelConfig;
  serverUrl: string;
}

export type iMessageAdapterConfig =
  | iMessageAdapterLocalConfig
  | iMessageAdapterRemoteConfig;

export class iMessageAdapter implements Adapter {
  readonly name = "imessage";
  readonly userName: string = "";
  readonly local: boolean;
  readonly serverUrl?: string;
  readonly apiKey?: string;
  readonly sdk: IMessageSDK | AdvancedIMessageKit;

  private chat: ChatInstance | null = null;
  private readonly logger: Logger;
  private readonly tracer: Tracer | null;
  private readonly metrics: AdapterMetrics;
  private readonly otelConfig: iMessageOTelConfig;
  private readonly tracerProvider?: TracerProvider;
  private readonly meterProvider?: MeterProvider;
  private readonly loggerProvider?: LoggerProvider;
  private readonly formatConverter = new iMessageFormatConverter();
  private readonly modalPollMap = new Map<
    string,
    {
      callbackId: string;
      selectId: string;
      options: SelectOptionElement[];
      contextId?: string;
      privateMetadata?: string;
    }
  >();

  constructor(config: iMessageAdapterConfig) {
    if (config.local && process.platform !== "darwin") {
      throw new ValidationError(
        "imessage",
        "iMessage adapter local mode requires macOS. Current platform: " +
          process.platform
      );
    }

    this.local = config.local;
    this.serverUrl = config.serverUrl;
    this.apiKey = config.apiKey;
    this.otelConfig = { ...DEFAULT_OTEL_CONFIG, ...config.otel };

    if (this.otelConfig.enabled) {
      this.tracerProvider =
        this.otelConfig.tracerProvider ?? trace.getTracerProvider();
      this.meterProvider =
        this.otelConfig.meterProvider ?? metrics.getMeterProvider();
      this.loggerProvider =
        this.otelConfig.loggerProvider ?? logs.getLoggerProvider();
      this.tracer = createTracer(this.tracerProvider);
      this.metrics = new AdapterMetrics(createMeter(this.meterProvider));
      this.logger = new OTelLogger(
        config.logger,
        this.loggerProvider,
        undefined,
        this.telemetryBaseAttributes(),
      );
    } else {
      this.tracer = null;
      this.metrics = NOOP_METRICS;
      this.logger = config.logger;
    }

    if (config.local) {
      this.sdk = new IMessageSDK();
    } else {
      this.sdk = AdvancedIMessageKit.getInstance({
        serverUrl: config.serverUrl,
        apiKey: config.apiKey,
      });
    }
  }

  async initialize(chat: ChatInstance): Promise<void> {
    return withSpan(this.tracer, SPAN_INITIALIZE, this.attrs(), async (span) => {
      this.chat = chat;
      this.logger.info("iMessage adapter initialized", {
        local: this.local,
        serverUrl: this.serverUrl ? "configured" : "not configured",
      });

      if (!this.local) {
        const sdk = this.sdk as AdvancedIMessageKit;
        await withSpan(this.tracer, SPAN_SDK_CONNECT, this.attrs(), async () => {
          await sdk.connect();
          await new Promise<void>((resolve) => sdk.once("ready", resolve));
        });
      }
    });
  }

  async handleWebhook(
    _request: Request,
    _options?: WebhookOptions
  ): Promise<Response> {
    return new Response("Webhook not supported -- use startGatewayListener()", {
      status: 501,
    });
  }

  async postMessage(
    threadId: string,
    message: AdapterPostableMessage
  ): Promise<RawMessage> {
    const { chatGuid } = this.decodeThreadId(threadId);
    const files = extractFiles(message);

    const modeAttr = { mode: this.local ? "local" : "remote" };
    const sendStart = Date.now();

    return withSpan(
      this.tracer,
      SPAN_POST_MESSAGE,
      this.attrs({ threadId, chatGuid, attachmentCount: files.length }),
      async (span) => {
        const text = this.formatConverter.renderPostable(message);
        const tempFiles =
          files.length > 0
            ? await withSpan(this.tracer, SPAN_FILES_WRITE_TEMP, {
                [ATTR_IMESSAGE_ATTACHMENT_COUNT]: files.length,
              }, () => this.writeTempFiles(files))
            : null;

        try {
          if (this.local) {
            const sdk = this.sdk as IMessageSDK;
            const recipient = chatGuid.split(";").pop() ?? chatGuid;
            const content = tempFiles?.paths.length
              ? { text: text || undefined, files: tempFiles.paths }
              : text;
            const result = await withSpan(
              this.tracer, SPAN_SDK_SEND_MESSAGE, this.attrs({ chatGuid }),
              () => sdk.send(recipient, content),
            );
            this.safeMetric(() => this.metrics.messagesSent.add(1, this.metricAttrs(modeAttr)));
            this.safeMetric(() => this.metrics.messageSendDuration.record(
              Date.now() - sendStart,
              this.metricAttrs(modeAttr),
            ));
            return {
              id: result.message?.guid ?? `local-${Date.now()}`,
              threadId,
              raw: result,
            };
          }

          const sdk = this.sdk as AdvancedIMessageKit;
          let result: MessageResponse | undefined;

          if (text || !tempFiles) {
            result = await withSpan(
              this.tracer, SPAN_SDK_SEND_MESSAGE, this.attrs({ chatGuid }),
              () => sdk.messages.sendMessage({ chatGuid, message: text }),
            );
          }

          if (tempFiles) {
            for (const filePath of tempFiles.paths) {
              const uploadStart = Date.now();
              const attachmentResult = await withSpan(
                this.tracer, SPAN_SDK_SEND_ATTACHMENT, this.attrs({ chatGuid }),
                () => sdk.attachments.sendAttachment({ chatGuid, filePath }),
              );
              this.safeMetric(() => this.metrics.attachmentsSent.add(1, this.metricAttrs(modeAttr)));
              this.safeMetric(() => this.metrics.attachmentUploadDuration.record(
                Date.now() - uploadStart,
                this.metricAttrs(modeAttr),
              ));
              result ??= attachmentResult;
            }
          }

          this.safeMetric(() => this.metrics.messagesSent.add(1, this.metricAttrs(modeAttr)));
          this.safeMetric(() => this.metrics.messageSendDuration.record(
            Date.now() - sendStart,
            this.metricAttrs(modeAttr),
          ));
          return {
            id: result?.guid ?? `msg-${Date.now()}`,
            threadId,
            raw: result,
          };
        } catch (error) {
          this.safeMetric(() => this.metrics.messageSendErrors.add(
            1,
            this.metricAttrs({
              ...modeAttr,
              [ATTR_ERROR_TYPE]: error instanceof Error ? error.constructor.name : "Unknown",
            }),
          ));
          throw error;
        } finally {
          if (tempFiles) {
            await withSpan(this.tracer, SPAN_FILES_CLEANUP, {}, () =>
              rm(tempFiles.dir, { recursive: true }).catch(() => {}),
            );
          }
        }
      },
    );
  }

  async editMessage(
    threadId: string,
    messageId: string,
    message: AdapterPostableMessage
  ): Promise<RawMessage> {
    return withSpan(
      this.tracer,
      SPAN_EDIT_MESSAGE,
      this.attrs({ threadId, messageId }),
      async () => {
        if (this.local) {
          throw new NotImplementedError(
            "editMessage is not supported in local mode",
            "editMessage"
          );
        }

        const text = this.formatConverter.renderPostable(message);
        const sdk = this.sdk as AdvancedIMessageKit;
        const result = await sdk.messages.editMessage({
          messageGuid: messageId,
          editedMessage: text,
          backwardsCompatibilityMessage: text,
        });
        return {
          id: result.guid,
          threadId,
          raw: result,
        };
      },
    );
  }

  async deleteMessage(_threadId: string, _messageId: string): Promise<void> {
    return withSpan(this.tracer, SPAN_DELETE_MESSAGE, this.attrs(), async () => {
      throw new NotImplementedError(
        "deleteMessage is not implemented",
        "deleteMessage"
      );
    });
  }

  parseMessage(raw: unknown): Message {
    const data = this.local
      ? this.normalizeLocalMessage(raw as IMessageLocalMessage)
      : this.normalizeRemoteMessage(raw as MessageResponse);
    return this.buildMessage(data);
  }

  async fetchMessages(
    threadId: string,
    options?: FetchOptions
  ): Promise<FetchResult> {
    const { chatGuid } = this.decodeThreadId(threadId);

    const fetchStart = Date.now();
    return withSpan(
      this.tracer,
      SPAN_FETCH_MESSAGES,
      this.attrs({ threadId, chatGuid }),
      async () => {
        const direction = options?.direction ?? "backward";
        const limit = options?.limit ?? 50;
        const cursor = options?.cursor;

        const result = this.local
          ? await this.fetchMessagesLocal(chatGuid, direction, limit, cursor)
          : await this.fetchMessagesRemote(chatGuid, direction, limit, cursor);

        this.safeMetric(() => this.metrics.fetchDuration.record(
          Date.now() - fetchStart,
          this.metricAttrs(),
        ));
        return result;
      },
    );
  }

  async fetchThread(threadId: string): Promise<ThreadInfo> {
    return withSpan(
      this.tracer,
      SPAN_FETCH_THREAD,
      this.attrs({ threadId }),
      async () => {
        if (this.local) {
          throw new NotImplementedError(
            "fetchThread is not supported in local mode",
            "fetchThread"
          );
        }

        const { chatGuid } = this.decodeThreadId(threadId);
        const sdk = this.sdk as AdvancedIMessageKit;
        const chat = await sdk.chats.getChat(chatGuid);
        const isDM = chatGuid.includes(";-;");

        return {
          id: threadId,
          channelId: chatGuid,
          channelName: chat.displayName || undefined,
          isDM,
          metadata: {
            chatIdentifier: chat.chatIdentifier,
            style: chat.style,
            participants: chat.participants,
            isArchived: chat.isArchived,
            raw: chat,
          },
        };
      },
    );
  }

  async addReaction(
    threadId: string,
    messageId: string,
    emoji: EmojiValue | string
  ): Promise<void> {
    return withSpan(
      this.tracer,
      SPAN_ADD_REACTION,
      this.attrs({ threadId, messageId }),
      async () => {
        if (this.local) {
          throw new NotImplementedError(
            "addReaction is not supported in local mode",
            "addReaction"
          );
        }

        const tapback = this.emojiToTapback(emoji);
        const { chatGuid } = this.decodeThreadId(threadId);
        const sdk = this.sdk as AdvancedIMessageKit;
        await sdk.messages.sendReaction({
          chatGuid,
          messageGuid: messageId,
          reaction: tapback,
        });
        this.safeMetric(() => this.metrics.reactionsSent.add(
          1,
          this.metricAttrs({ tapback_type: tapback }),
        ));
      },
    );
  }

  async removeReaction(
    threadId: string,
    messageId: string,
    emoji: EmojiValue | string
  ): Promise<void> {
    return withSpan(
      this.tracer,
      SPAN_REMOVE_REACTION,
      this.attrs({ threadId, messageId }),
      async () => {
        if (this.local) {
          throw new NotImplementedError(
            "removeReaction is not supported in local mode",
            "removeReaction"
          );
        }

        const tapback = this.emojiToTapback(emoji);
        const { chatGuid } = this.decodeThreadId(threadId);
        const sdk = this.sdk as AdvancedIMessageKit;
        await sdk.messages.sendReaction({
          chatGuid,
          messageGuid: messageId,
          reaction: `-${tapback}`,
        });
      },
    );
  }

  async startTyping(threadId: string, _status?: string): Promise<void> {
    return withSpan(
      this.tracer,
      SPAN_START_TYPING,
      this.attrs({ threadId }),
      async () => {
        if (this.local) {
          throw new NotImplementedError(
            "startTyping is not supported in local mode",
            "startTyping"
          );
        }

        const { chatGuid } = this.decodeThreadId(threadId);
        const sdk = this.sdk as AdvancedIMessageKit;
        await sdk.chats.startTyping(chatGuid);
        setTimeout(() => sdk.chats.stopTyping(chatGuid), 3000);
      },
    );
  }

  async openModal(
    triggerId: string,
    modal: ModalElement,
    contextId?: string
  ): Promise<{ viewId: string }> {
    return withSpan(
      this.tracer,
      SPAN_OPEN_MODAL,
      this.attrs({ threadId: triggerId }),
      async () => {
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

        const { chatGuid } = this.decodeThreadId(triggerId);
        const sdk = this.sdk as AdvancedIMessageKit;

        const result = await sdk.polls.create({
          chatGuid,
          title: modal.title,
          options: select.options.map((o) => o.label),
        });

        this.modalPollMap.set(result.guid, {
          callbackId: modal.callbackId,
          selectId: select.id,
          options: select.options,
          contextId,
          privateMetadata: modal.privateMetadata,
        });

        this.safeMetric(() => this.metrics.pollsCreated.add(1, this.metricAttrs()));
        return { viewId: result.guid };
      },
    );
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
    return withSpan(
      this.tracer,
      SPAN_GATEWAY_LISTENER,
      {
        ...this.attrs(),
        [ATTR_GATEWAY_DURATION_MS]: durationMs,
      },
      async () => {
        if (!this.chat) {
          return new Response("Chat instance not initialized", { status: 500 });
        }

        if (!options.waitUntil) {
          return new Response("waitUntil not provided", { status: 500 });
        }

        this.logger.info("Starting iMessage Gateway listener", {
          durationMs,
          mode: this.local ? "local" : "remote",
        });

        this.safeMetric(() => this.metrics.gatewaySessions.add(
          1,
          this.metricAttrs({ mode: this.local ? "local" : "remote" }),
        ));
        this.safeMetric(() => this.metrics.activeGatewayListeners.add(1, this.metricAttrs()));

        const sessionStart = Date.now();
        const listenerPromise = this.runGatewayListener(durationMs, abortSignal, options)
          .finally(() => {
            this.safeMetric(() => this.metrics.activeGatewayListeners.add(-1, this.metricAttrs()));
            this.safeMetric(() => this.metrics.gatewaySessionDuration.record(
              Date.now() - sessionStart,
              this.metricAttrs(),
            ));
            return this.flushTelemetry();
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
      },
    );
  }

  private async runGatewayListener(
    durationMs: number,
    abortSignal?: AbortSignal,
    options?: WebhookOptions
  ): Promise<void> {
    return withSpan(
      this.tracer,
      SPAN_GATEWAY_RUNNER,
      {
        ...this.attrs(),
        [ATTR_GATEWAY_DURATION_MS]: durationMs,
      },
      async (runnerSpan) => {
        let isShuttingDown = false;
        let remoteGatewaySdk: AdvancedIMessageKit | null = null;
        let messagesReceived = 0;
        let errorsEncountered = 0;

        try {
          if (this.local) {
            const sdk = this.sdk as IMessageSDK;
            await sdk.startWatching({
              onMessage: async (message: IMessageLocalMessage) => {
                if (isShuttingDown) return;
                if (message.isFromMe) return;
                messagesReceived++;
                this.safeMetric(() => this.metrics.messagesReceived.add(
                  1,
                  this.metricAttrs({
                    mode: "local",
                    is_group: String(message.isGroupChat),
                    source: "local",
                  }),
                ));
                const data = this.normalizeLocalMessage(message);
                this.handleGatewayMessage(data);
              },
              onError: (error: Error) => {
                errorsEncountered++;
                this.safeMetric(() => this.metrics.gatewayErrors.add(
                  1,
                  this.metricAttrs({ mode: "local" }),
                ));
                this.logger.error("iMessage local watcher error", {
                  error: String(error),
                });
              },
            });
          } else {
            remoteGatewaySdk = new AdvancedIMessageKit({
              serverUrl: this.serverUrl,
              apiKey: this.apiKey,
            });

            await withSpan(this.tracer, SPAN_SDK_CONNECT, this.attrs(), () =>
              remoteGatewaySdk!.connect(),
            );

            remoteGatewaySdk.on(
              "new-message",
              async (messageResponse: MessageResponse) => {
                if (isShuttingDown) return;
                if (messageResponse.isFromMe) return;

                if (isPollVote(messageResponse)) {
                  withSpan(
                    this.tracer,
                    SPAN_POLL_VOTE_RECEIVE,
                    this.attrs({ messageId: messageResponse.guid }),
                    async () => {
                      this.handlePollVoteAsModalSubmit(messageResponse, options);
                    },
                  ).catch((err) => {
                    errorsEncountered++;
                    this.safeMetric(() => this.metrics.gatewayErrors.add(
                      1,
                      this.metricAttrs({ mode: "remote" }),
                    ));
                    this.logger.error("Poll vote processing error", {
                      error: String(err),
                    });
                  });
                  return;
                }

                messagesReceived++;
                const chatGuid = messageResponse.chats?.[0]?.guid ?? "";
                this.safeMetric(() => this.metrics.messagesReceived.add(
                  1,
                  this.metricAttrs({
                    mode: "remote",
                    is_group: String(!chatGuid.includes(";-;")),
                    source: "remote",
                  }),
                ));

                withSpan(
                  this.tracer,
                  SPAN_MESSAGE_RECEIVE,
                  this.attrs({
                    messageId: messageResponse.guid,
                    chatGuid,
                  }),
                  async () => {
                    const data = this.normalizeRemoteMessage(messageResponse);
                    this.handleGatewayMessage(data, options);
                  },
                ).catch((err) => {
                  errorsEncountered++;
                  this.safeMetric(() => this.metrics.gatewayErrors.add(
                    1,
                    this.metricAttrs({ mode: "remote" }),
                  ));
                  this.logger.error("Message processing error", {
                    error: String(err),
                  });
                });
              }
            );
          }

          await new Promise<void>((resolve) => {
            const timeout = setTimeout(resolve, durationMs);
            if (abortSignal) {
              if (abortSignal.aborted) {
                clearTimeout(timeout);
                resolve();
                return;
              }
              abortSignal.addEventListener(
                "abort",
                () => {
                  this.logger.info(
                    "iMessage Gateway listener received abort signal"
                  );
                  clearTimeout(timeout);
                  resolve();
                },
                { once: true }
              );
            }
          });

          runnerSpan.setAttribute(ATTR_GATEWAY_ABORTED, !!abortSignal?.aborted);
          this.logger.info(
            "iMessage Gateway listener duration elapsed, disconnecting"
          );
        } catch (error) {
          errorsEncountered++;
          this.logger.error("iMessage Gateway listener error", {
            error: String(error),
          });
        } finally {
          runnerSpan.setAttribute(ATTR_GATEWAY_MESSAGES_RECEIVED, messagesReceived);
          runnerSpan.setAttribute(ATTR_GATEWAY_ERRORS, errorsEncountered);

          isShuttingDown = true;
          if (this.local) {
            (this.sdk as IMessageSDK).stopWatching();
          } else if (remoteGatewaySdk) {
            await withSpan(this.tracer, SPAN_SDK_DISCONNECT, this.attrs(), () =>
              remoteGatewaySdk!.close(),
            );
          }
          this.logger.info("iMessage Gateway listener stopped");
        }
      },
    );
  }

  private handlePollVoteAsModalSubmit(
    messageResponse: MessageResponse,
    options?: WebhookOptions
  ): void {
    if (!this.chat) return;

    const pollGuid = messageResponse.associatedMessageGuid;
    if (!pollGuid) {
      this.safeMetric(() => this.metrics.pollVotesDropped.add(
        1,
        this.metricAttrs({ reason: "missing_guid" }),
      ));
      this.logger.debug("Poll vote missing associatedMessageGuid, skipping");
      return;
    }

    const meta = this.modalPollMap.get(pollGuid);
    if (!meta) {
      this.safeMetric(() => this.metrics.pollVotesDropped.add(
        1,
        this.metricAttrs({ reason: "unknown_poll" }),
      ));
      this.logger.debug("Poll vote for unknown poll, skipping", { pollGuid });
      return;
    }

    const parsed = parsePollVotes(messageResponse);
    if (!parsed) {
      this.safeMetric(() => this.metrics.pollVotesDropped.add(
        1,
        this.metricAttrs({ reason: "parse_failed" }),
      ));
      this.logger.debug("Failed to parse poll votes", {
        guid: messageResponse.guid,
      });
      return;
    }

    for (const vote of parsed.votes) {
      const optionIndex = Number.parseInt(vote.voteOptionIdentifier, 10);
      const option = Number.isNaN(optionIndex)
        ? undefined
        : meta.options[optionIndex];
      const value = option?.value ?? vote.voteOptionIdentifier;

      this.safeMetric(() => this.metrics.pollVotesReceived.add(1, this.metricAttrs()));
      this.chat.processModalSubmit(
        {
          adapter: this,
          callbackId: meta.callbackId,
          privateMetadata: meta.privateMetadata,
          viewId: pollGuid,
          user: {
            userId: vote.participantHandle,
            userName: vote.participantHandle,
            fullName: vote.participantHandle,
            isBot: false,
            isMe: false,
          },
          values: { [meta.selectId]: value },
          raw: messageResponse,
        },
        meta.contextId,
        options
      );
    }
  }

  private async writeTempFiles(
    files: FileUpload[]
  ): Promise<{ dir: string; paths: string[] }> {
    const dir = await mkdtemp(join(tmpdir(), "imessage-"));
    const paths: string[] = [];
    for (const file of files) {
      let buffer: Buffer;
      if (Buffer.isBuffer(file.data)) {
        buffer = file.data;
      } else if (file.data instanceof Blob) {
        buffer = Buffer.from(await file.data.arrayBuffer());
      } else {
        buffer = Buffer.from(file.data as ArrayBuffer);
      }
      const filePath = join(dir, file.filename);
      await writeFile(filePath, buffer);
      paths.push(filePath);
    }
    return { dir, paths };
  }

  private async fetchMessagesLocal(
    chatGuid: string,
    direction: "forward" | "backward",
    limit: number,
    cursor?: string
  ): Promise<FetchResult> {
    const sdk = this.sdk as IMessageSDK;
    const since =
      direction === "forward" && cursor ? new Date(cursor) : undefined;
    const result = await sdk.getMessages({
      chatId: chatGuid,
      limit: 1000,
      since,
    });

    let messages = [...result.messages].sort(
      (a, b) => a.date.getTime() - b.date.getTime()
    );

    if (direction === "backward" && cursor) {
      const cursorTime = new Date(cursor).getTime();
      messages = messages.filter((m) => m.date.getTime() < cursorTime);
    }

    const isBackward = direction === "backward";
    const start = isBackward ? Math.max(0, messages.length - limit) : 0;
    const selected = messages.slice(start, start + limit);
    const hasMore = isBackward ? start > 0 : messages.length > limit;

    const normalized = selected.map((m) =>
      this.buildMessage(this.normalizeLocalMessage(m))
    );

    let nextCursor: string | undefined;
    if (hasMore && selected.length > 0) {
      nextCursor = isBackward
        ? selected[0].date.toISOString()
        : selected.at(-1)?.date.toISOString();
    }

    return { messages: normalized, nextCursor };
  }

  private async fetchMessagesRemote(
    chatGuid: string,
    direction: "forward" | "backward",
    limit: number,
    cursor?: string
  ): Promise<FetchResult> {
    const sdk = this.sdk as AdvancedIMessageKit;
    const isBackward = direction === "backward";

    const queryOptions: {
      chatGuid: string;
      limit: number;
      sort: "ASC" | "DESC";
      before?: number;
      after?: number;
      with?: string[];
    } = {
      chatGuid,
      limit: limit + 1,
      sort: isBackward ? "DESC" : "ASC",
      with: ["chat", "handle", "attachment"],
    };

    if (cursor) {
      const timestamp = Number(cursor);
      if (isBackward) {
        queryOptions.before = timestamp;
      } else {
        queryOptions.after = timestamp;
      }
    }

    const results = await sdk.messages.getMessages(queryOptions);
    const hasMore = results.length > limit;
    const sliced = hasMore ? results.slice(0, limit) : results;

    if (isBackward) {
      sliced.reverse();
    }

    const normalized = sliced.map((m) =>
      this.buildMessage(this.normalizeRemoteMessage(m))
    );

    let nextCursor: string | undefined;
    if (hasMore && sliced.length > 0) {
      nextCursor = isBackward
        ? String(sliced[0].dateCreated)
        : String(sliced.at(-1)?.dateCreated);
    }

    return { messages: normalized, nextCursor };
  }

  private normalizeLocalMessage(
    message: IMessageLocalMessage
  ): iMessageGatewayMessageData {
    return {
      guid: message.guid,
      text: message.text,
      sender: message.sender,
      senderName: message.senderName,
      chatId: message.chatId,
      isGroupChat: message.isGroupChat,
      isFromMe: message.isFromMe,
      date: message.date.toISOString(),
      attachments: message.attachments.map((a) => ({
        id: a.id,
        filename: a.filename,
        mimeType: a.mimeType,
        size: a.size,
      })),
      source: "local",
      raw: message,
    };
  }

  private normalizeRemoteMessage(
    messageResponse: MessageResponse
  ): iMessageGatewayMessageData {
    const chatGuid = messageResponse.chats?.[0]?.guid ?? "";
    const isGroupChat = !chatGuid.includes(";-;");

    return {
      guid: messageResponse.guid,
      text: messageResponse.text,
      sender: messageResponse.handle?.address ?? "",
      senderName: null,
      chatId: chatGuid,
      isGroupChat,
      isFromMe: messageResponse.isFromMe,
      date: new Date(messageResponse.dateCreated).toISOString(),
      attachments: (messageResponse.attachments ?? []).map((a) => ({
        id: a.guid,
        filename: a.transferName,
        mimeType: a.mimeType ?? "application/octet-stream",
        size: a.totalBytes,
      })),
      source: "remote",
      raw: messageResponse,
    };
  }

  private buildMessage(data: iMessageGatewayMessageData): Message {
    const threadId = this.encodeThreadId({ chatGuid: data.chatId });
    return new Message({
      id: data.guid,
      threadId,
      text: data.text ?? "",
      formatted: parseMarkdown(data.text ?? ""),
      author: {
        userId: data.sender,
        userName: data.senderName ?? data.sender,
        fullName: data.senderName ?? data.sender,
        isBot: false,
        isMe: data.isFromMe,
      },
      metadata: {
        dateSent: new Date(data.date),
        edited: false,
      },
      attachments: data.attachments.map((a) => ({
        type: this.getAttachmentType(a.mimeType),
        name: a.filename,
        mimeType: a.mimeType,
        size: a.size,
      })),
      raw: data.raw ?? data,
      isMention: !data.isGroupChat,
    });
  }

  private handleGatewayMessage(
    data: iMessageGatewayMessageData,
    options?: WebhookOptions
  ): void {
    if (!this.chat) return;
    const chatMessage = this.buildMessage(data);
    this.chat.processMessage(this, chatMessage.threadId, chatMessage, options);
  }

  private emojiToTapback(emoji: EmojiValue | string): string {
    const name = typeof emoji === "string" ? emoji : emoji.name;
    const tapbackMap: Record<string, string> = {
      heart: "love",
      love: "love",
      thumbs_up: "like",
      like: "like",
      thumbs_down: "dislike",
      dislike: "dislike",
      laugh: "laugh",
      emphasize: "emphasize",
      exclamation: "emphasize",
      question: "question",
    };
    const tapback = tapbackMap[name];
    if (!tapback) {
      throw new ValidationError(
        "imessage",
        `Unsupported iMessage tapback: "${name}". Supported: heart, thumbs_up, thumbs_down, laugh, emphasize, question`
      );
    }
    return tapback;
  }

  /** Safely record a metric — never let telemetry failures propagate. */
  private safeMetric(fn: () => void): void {
    try { fn(); } catch { /* telemetry failure — swallow */ }
  }

  private attrs(opts?: Parameters<typeof buildCommonAttributes>[1]) {
    return buildCommonAttributes(this.local ? "local" : "remote", {
      ...opts,
      redactPII: this.otelConfig.redactPII,
      serviceName: this.otelConfig.serviceName,
    });
  }

  private telemetryBaseAttributes(): Record<string, string> {
    if (!this.otelConfig.serviceName) {
      return {};
    }

    return {
      [ATTR_SERVICE_NAME]: this.otelConfig.serviceName,
    };
  }

  private metricAttrs(
    attrs?: Record<string, string | number | boolean>,
  ): Record<string, string | number | boolean> | undefined {
    if (!this.otelConfig.serviceName) {
      return attrs;
    }

    return {
      [ATTR_SERVICE_NAME]: this.otelConfig.serviceName,
      ...attrs,
    };
  }

  /**
   * Attempt to flush OTel providers. Best-effort — providers from the API
   * interface don't expose forceFlush, but SDK implementations do.
   */
  private async flushTelemetry(): Promise<void> {
    const flush = async (provider: unknown) => {
      if (
        provider &&
        typeof provider === "object" &&
        "forceFlush" in provider &&
        typeof (provider as { forceFlush: () => Promise<void> }).forceFlush === "function"
      ) {
        await (provider as { forceFlush: () => Promise<void> }).forceFlush();
      }
    };

    await Promise.allSettled([
      flush(this.tracerProvider),
      flush(this.meterProvider),
      flush(this.loggerProvider),
    ]);
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
  config?: Partial<iMessageAdapterConfig>
): iMessageAdapter {
  const local = config?.local ?? process.env.IMESSAGE_LOCAL !== "false";
  const logger = config?.logger ?? new ConsoleLogger("info").child("imessage");

  if (local) {
    return new iMessageAdapter({
      local: true,
      logger,
      otel: config?.otel,
      serverUrl: config?.serverUrl ?? process.env.IMESSAGE_SERVER_URL,
      apiKey: config?.apiKey ?? process.env.IMESSAGE_API_KEY,
    });
  }

  const serverUrl = config?.serverUrl ?? process.env.IMESSAGE_SERVER_URL;
  if (!serverUrl) {
    throw new ValidationError(
      "imessage",
      "serverUrl is required when local is false. Set IMESSAGE_SERVER_URL or provide it in config."
    );
  }

  const apiKey = config?.apiKey ?? process.env.IMESSAGE_API_KEY;
  if (!apiKey) {
    throw new ValidationError(
      "imessage",
      "apiKey is required when local is false. Set IMESSAGE_API_KEY or provide it in config."
    );
  }

  return new iMessageAdapter({
    local: false,
    logger,
    otel: config?.otel,
    serverUrl,
    apiKey,
  });
}
