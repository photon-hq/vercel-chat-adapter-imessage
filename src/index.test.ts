import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks: @spectrum-ts/core + @spectrum-ts/imessage. Content builders are
// replaced with inspectable passthroughs so we can assert on what was sent.
// ---------------------------------------------------------------------------

const { mockSpectrum, mockImessageConfig, mockImessage } = vi.hoisted(() => ({
  mockSpectrum: vi.fn(),
  mockImessageConfig: vi.fn((c: unknown) => ({ __providerConfig: c })),
  mockImessage: vi.fn(),
}));

vi.mock("@spectrum-ts/core", () => ({
  Spectrum: mockSpectrum,
  text: (t: string) => ({ __kind: "text", text: t }),
  markdown: (m: string) => ({ __kind: "markdown", markdown: m }),
  attachment: (data: unknown, options: unknown) => ({
    __kind: "attachment",
    data,
    options,
  }),
  poll: (title: string, options: unknown) => ({
    __kind: "poll",
    title,
    options,
  }),
  app: (url: unknown) => ({ __kind: "app", url }),
  voice: (input: unknown, options: unknown) => ({
    __kind: "voice",
    input,
    options,
  }),
}));

vi.mock("@spectrum-ts/imessage", () => ({
  imessage: Object.assign(mockImessage, {
    config: mockImessageConfig,
    effect: {
      message: {
        slam: "com.apple.MobileSMS.expressivesend.impact",
        loud: "com.apple.MobileSMS.expressivesend.loud",
        gentle: "com.apple.MobileSMS.expressivesend.gentle",
        invisible: "com.apple.MobileSMS.expressivesend.invisibleink",
        confetti: "com.apple.messages.effect.CKConfettiEffect",
        fireworks: "com.apple.messages.effect.CKFireworksEffect",
        balloons: "com.apple.messages.effect.CKBalloonEffect",
        heart: "com.apple.messages.effect.CKHeartEffect",
        lasers: "com.apple.messages.effect.CKLasersEffect",
        celebration: "com.apple.messages.effect.CKHappyBirthdayEffect",
        sparkles: "com.apple.messages.effect.CKSparklesEffect",
        spotlight: "com.apple.messages.effect.CKSpotlightEffect",
        echo: "com.apple.messages.effect.CKEchoEffect",
      },
    },
  }),
  effect: (content: unknown, messageEffect: string) => ({
    __kind: "effect",
    content,
    effect: messageEffect,
  }),
  customizedMiniApp: (input: unknown) => ({ __kind: "mini-app", input }),
  background: (input: unknown, options: unknown) => ({
    __kind: "background",
    input,
    options,
  }),
}));

vi.mock("chat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("chat")>();
  return {
    ...actual,
    parseMarkdown: vi.fn((text: string) => ({
      type: "root",
      children: [
        { type: "paragraph", children: [{ type: "text", value: text }] },
      ],
    })),
  };
});

import { createHmac } from "node:crypto";
import { ValidationError } from "@chat-adapter/shared";
import type { ModalElement } from "chat";
import { NotImplementedError } from "chat";
import { createiMessageAdapter, deriveAddress, iMessageAdapter } from "./index";

// Every gateway listener leaves a long `waitUntil` timer + a live message pump
// running; track them so afterEach can abort and await termination.
const openListeners: Array<{
  controller: AbortController;
  promise: Promise<unknown>;
}> = [];

async function startTrackedListener(
  adapter: iMessageAdapter,
  durationMs = 60_000
): Promise<{
  controller: AbortController;
  promise: Promise<unknown>;
  response: Response;
  waitUntil: ReturnType<typeof vi.fn>;
}> {
  const controller = new AbortController();
  let promise: Promise<unknown> = Promise.resolve();
  const waitUntil = vi.fn((task: Promise<unknown>) => {
    promise = task;
  });
  const response = await adapter.startGatewayListener(
    { waitUntil },
    durationMs,
    controller.signal
  );
  openListeners.push({ controller, promise });
  return { controller, promise, response, waitUntil };
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(() => mockLogger),
};

type Tuple = [MockSpace, MockMessage];

interface MockSpace {
  __platform: string;
  avatar: ReturnType<typeof vi.fn>;
  edit: ReturnType<typeof vi.fn>;
  getMessage: ReturnType<typeof vi.fn>;
  id: string;
  read: ReturnType<typeof vi.fn>;
  rename: ReturnType<typeof vi.fn>;
  responding: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  startTyping: ReturnType<typeof vi.fn>;
  stopTyping: ReturnType<typeof vi.fn>;
  type: "dm" | "group";
  unsend: ReturnType<typeof vi.fn>;
}

interface MockMessage {
  content: unknown;
  direction: "inbound" | "outbound";
  edit: ReturnType<typeof vi.fn>;
  id: string;
  platform: string;
  react: ReturnType<typeof vi.fn>;
  read: ReturnType<typeof vi.fn>;
  reply: ReturnType<typeof vi.fn>;
  sender: { id: string; __platform: string } | undefined;
  space: MockSpace;
  timestamp: Date;
  unsend: ReturnType<typeof vi.fn>;
}

let mockApp: ReturnType<typeof createMockApp>["app"];
let pushInbound: (t: Tuple) => void;
let iteratorReturnSpy: ReturnType<typeof vi.fn>;
let mockChat: {
  processMessage: ReturnType<typeof vi.fn>;
  processModalSubmit: ReturnType<typeof vi.fn>;
};

function createMockApp() {
  const queue: Tuple[] = [];
  let parked: ((r: IteratorResult<Tuple>) => void) | null = null;
  let closed = false;
  const returnSpy = vi.fn();

  const done = (): IteratorResult<Tuple> => ({
    done: true,
    value: undefined as never,
  });

  const iterator: AsyncIterator<Tuple> = {
    next() {
      return new Promise<IteratorResult<Tuple>>((resolve) => {
        if (closed) {
          resolve(done());
          return;
        }
        const item = queue.shift();
        if (item) {
          resolve({ done: false, value: item });
          return;
        }
        parked = resolve;
      });
    },
    return() {
      closed = true;
      returnSpy();
      if (parked) {
        const p = parked;
        parked = null;
        p(done());
      }
      return Promise.resolve(done());
    },
  };

  const app = {
    messages: { [Symbol.asyncIterator]: () => iterator },
    stop: vi.fn(),
    send: vi.fn(),
    edit: vi.fn(),
    responding: vi.fn(),
    webhook: vi.fn(),
  };

  const push = (t: Tuple) => {
    if (parked) {
      const p = parked;
      parked = null;
      p({ done: false, value: t });
    } else {
      queue.push(t);
    }
  };

  return { app, push, returnSpy };
}

function makeSpace(
  id: string,
  type: "dm" | "group" = "dm",
  sendResult: unknown = { id: "sent-msg-1" }
): MockSpace {
  return {
    id,
    __platform: "iMessage",
    type,
    send: vi.fn(async () => sendResult),
    getMessage: vi.fn(async () => undefined),
    startTyping: vi.fn(async () => undefined),
    stopTyping: vi.fn(async () => undefined),
    edit: vi.fn(async () => undefined),
    unsend: vi.fn(async () => undefined),
    read: vi.fn(async () => undefined),
    responding: vi.fn(async (fn: () => unknown) => fn()),
    rename: vi.fn(),
    avatar: vi.fn(),
  };
}

function makeMessage(
  id: string,
  space: MockSpace,
  content: unknown,
  opts: {
    direction?: "inbound" | "outbound";
    sender?: string | null;
    timestamp?: Date;
  } = {}
): MockMessage {
  const sender =
    opts.sender === null
      ? undefined
      : { id: opts.sender ?? "+1234567890", __platform: "iMessage" };
  return {
    id,
    space,
    content,
    sender,
    timestamp: opts.timestamp ?? new Date("2026-01-15T12:00:00Z"),
    platform: "iMessage",
    direction: opts.direction ?? "inbound",
    react: vi.fn(async () => makeReaction(`reaction-of-${id}`, space)),
    reply: vi.fn(async () => undefined),
    edit: vi.fn(async () => undefined),
    unsend: vi.fn(async () => undefined),
    read: vi.fn(async () => undefined),
  };
}

/**
 * A tapback reaction message — what spectrum-ts's `message.react()` resolves
 * to. `addReaction` keeps this so `removeReaction` can `unsend()` it.
 */
function makeReaction(id: string, space: MockSpace): MockMessage {
  return makeMessage(
    id,
    space,
    { type: "reaction" },
    { direction: "outbound" }
  );
}

function cloudAdapter(): iMessageAdapter {
  return new iMessageAdapter({
    local: false,
    logger: mockLogger,
    projectId: "proj",
    projectSecret: "secret",
  });
}

const WEBHOOK_SECRET = "whsec_test_0123456789";

function webhookAdapter(webhookSecret = WEBHOOK_SECRET): iMessageAdapter {
  return new iMessageAdapter({
    local: false,
    logger: mockLogger,
    projectId: "proj",
    projectSecret: "secret",
    webhookSecret,
  });
}

/**
 * Build a Spectrum Cloud webhook request, signing the body the way Spectrum
 * does (`v0=` + HMAC-SHA256 over `v0:{timestamp}:{rawBody}`). Pass `signature`
 * or `timestamp` to forge an invalid/stale delivery.
 */
function signedWebhookRequest(opts: {
  body: unknown;
  event?: string;
  secret?: string;
  signature?: string;
  timestamp?: number;
}): Request {
  const secret = opts.secret ?? WEBHOOK_SECRET;
  const rawBody =
    typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  const ts = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
  const signature =
    opts.signature ??
    `v0=${createHmac("sha256", secret).update(`v0:${ts}:${rawBody}`).digest("hex")}`;
  return new Request("https://example.com/api/imessage/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-spectrum-event": opts.event ?? "messages",
      "x-spectrum-timestamp": ts,
      "x-spectrum-signature": signature,
      "x-spectrum-webhook-id": "wh-test-1",
    },
    body: rawBody,
  });
}

function textMessagePayload(
  overrides: {
    chatGuid?: string;
    direction?: "inbound" | "outbound";
    text?: string;
    content?: unknown;
    phone?: string;
  } = {}
): Record<string, unknown> {
  const chatGuid = overrides.chatGuid ?? "iMessage;-;+1234567890";
  const space = {
    id: chatGuid,
    platform: "iMessage",
    type: "dm",
    ...(overrides.phone ? { phone: overrides.phone } : {}),
  };
  return {
    event: "messages",
    space,
    message: {
      id: "wh-msg-1",
      platform: "iMessage",
      direction: overrides.direction ?? "inbound",
      timestamp: "2026-05-14T19:06:32.000Z",
      sender: { id: "+1234567890", platform: "iMessage" },
      space,
      content: overrides.content ?? {
        type: "text",
        text: overrides.text ?? "hey from webhook",
      },
    },
  };
}

async function init(adapter: iMessageAdapter): Promise<void> {
  await adapter.initialize(mockChat as never);
}

/**
 * Start the gateway listener and deliver one inbound message so its Space (and
 * Message) land in the adapter's cache — the prerequisite for the stateless,
 * threadId-addressed methods.
 */
async function primeInbound(
  adapter: iMessageAdapter,
  opts: {
    chatGuid: string;
    type?: "dm" | "group";
    content?: unknown;
    sendResult?: unknown;
    messageId?: string;
  }
): Promise<{ space: MockSpace; message: MockMessage }> {
  const space = makeSpace(opts.chatGuid, opts.type ?? "dm", opts.sendResult);
  const message = makeMessage(
    opts.messageId ?? "in-msg-1",
    space,
    opts.content ?? { type: "text", text: "hi" }
  );
  await startTrackedListener(adapter);
  pushInbound([space, message]);
  // Condition-based wait (no assertion in this helper — that would be a
  // misplaced expect); the assertions live in the test bodies.
  await vi.waitFor(() => {
    if (mockChat.processMessage.mock.calls.length === 0) {
      throw new Error("inbound message was not processed");
    }
  });
  return { space, message };
}

beforeEach(() => {
  const harness = createMockApp();
  mockApp = harness.app;
  pushInbound = harness.push;
  iteratorReturnSpy = harness.returnSpy;
  mockChat = { processMessage: vi.fn(), processModalSubmit: vi.fn() };

  mockSpectrum.mockReset();
  mockSpectrum.mockResolvedValue(mockApp);
  mockImessageConfig.mockClear();
  // Default: `imessage(app).space.get(chatGuid)` rebuilds a space by chat GUID.
  // Tests that assert on the resolved space override this per-case.
  mockImessage.mockReset();
  mockImessage.mockImplementation(() => ({
    space: {
      get: vi.fn(async (id: string) =>
        makeSpace(id, id.includes(";-;") ? "dm" : "group")
      ),
      // `space.create(userId)` resolves/creates a 1:1 DM — a synthetic DM chat
      // GUID for the handle, which `openDM` encodes into a thread id.
      create: vi.fn(async (userId: string) =>
        makeSpace(`iMessage;-;${userId}`, "dm")
      ),
    },
  }));
  for (const fn of Object.values(mockLogger)) {
    fn.mockClear?.();
  }
});

afterEach(async () => {
  // Real timers first, so clearTimeout in the listener teardown targets the
  // real (not faked) duration timer.
  vi.useRealTimers();
  for (const listener of openListeners) {
    listener.controller.abort();
  }
  await Promise.allSettled(openListeners.map((listener) => listener.promise));
  openListeners.length = 0;
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------

describe("iMessageAdapter constructor", () => {
  it("has the correct name", () => {
    expect(cloudAdapter().name).toBe("imessage");
  });

  it("starts with no app until initialized", () => {
    expect(cloudAdapter().app).toBeNull();
  });

  it("stores self-host config", () => {
    const adapter = new iMessageAdapter({
      logger: mockLogger,
      serverUrl: "grpc.example.com:443",
      apiKey: "test-key",
    });
    expect(adapter.serverUrl).toBe("grpc.example.com:443");
    expect(adapter.apiKey).toBe("test-key");
  });

  it("stores cloud config", () => {
    const adapter = cloudAdapter();
    expect(adapter.projectId).toBe("proj");
    expect(adapter.projectSecret).toBe("secret");
  });

  it("trims the webhook secret on direct construction", () => {
    const adapter = new iMessageAdapter({
      local: false,
      logger: mockLogger,
      projectId: "p",
      projectSecret: "s",
      webhookSecret: "  whsec_raw  ",
    });
    expect(adapter.webhookSecret).toBe("whsec_raw");
  });

  it("throws when the removed local mode is requested", () => {
    expect(
      () =>
        new iMessageAdapter({
          local: true,
          logger: mockLogger,
        } as never)
    ).toThrow("Local (on-device) mode was removed");
  });
});

describe("initialize", () => {
  it("passes cloud credentials to Spectrum", async () => {
    await init(cloudAdapter());
    expect(mockImessageConfig).toHaveBeenCalledWith({});
    expect(mockSpectrum).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "proj", projectSecret: "secret" })
    );
  });

  it("maps legacy serverUrl/apiKey to a self-host clients entry (gRPC address)", async () => {
    const adapter = new iMessageAdapter({
      local: false,
      logger: mockLogger,
      serverUrl: "https://example.com",
      apiKey: "test-key",
    });
    await init(adapter);
    expect(mockImessageConfig).toHaveBeenCalledWith({
      clients: [
        { address: "example.com:443", token: "test-key", phone: "shared" },
      ],
    });
    // No cloud creds passed.
    expect(mockSpectrum).toHaveBeenCalledWith({
      providers: [expect.anything()],
    });
  });

  it("exposes the Spectrum instance as adapter.app", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    expect(adapter.app).toBe(mockApp);
  });
});

describe("encodeThreadId / decodeThreadId / isDM", () => {
  it("encodes and decodes", () => {
    const adapter = cloudAdapter();
    const threadId = adapter.encodeThreadId({
      chatGuid: "iMessage;-;+1234567890",
    });
    expect(threadId).toBe("imessage:iMessage;-;+1234567890");
    expect(adapter.decodeThreadId(threadId)).toEqual({
      chatGuid: "iMessage;-;+1234567890",
    });
  });

  it("round-trips the sending line encoded in the thread ID", () => {
    const adapter = cloudAdapter();
    const threadId = adapter.encodeThreadId({
      chatGuid: "iMessage;-;+1234567890",
      phone: "+15550001111",
    });
    expect(threadId).toBe("imessage:iMessage;-;+1234567890~+15550001111");
    expect(adapter.decodeThreadId(threadId)).toEqual({
      chatGuid: "iMessage;-;+1234567890",
      phone: "+15550001111",
    });
  });

  it("decodes a legacy thread ID (no line) without a phone", () => {
    expect(
      cloudAdapter().decodeThreadId("imessage:iMessage;-;+1234567890")
    ).toEqual({ chatGuid: "iMessage;-;+1234567890" });
  });

  it("throws on a thread ID from another adapter", () => {
    expect(() => cloudAdapter().decodeThreadId("slack:C123")).toThrow(
      "Invalid iMessage thread ID"
    );
  });

  it("throws on an empty chat GUID", () => {
    expect(() => cloudAdapter().decodeThreadId("imessage:")).toThrow(
      "Invalid iMessage thread ID"
    );
  });

  it("detects DM vs group", () => {
    const adapter = cloudAdapter();
    expect(adapter.isDM("imessage:iMessage;-;+1234567890")).toBe(true);
    expect(adapter.isDM("imessage:iMessage;+;chat493787071395575843")).toBe(
      false
    );
    expect(adapter.isDM("imessage:SMS;-;+1234567890")).toBe(true);
  });
});

describe("channelIdFromThreadId", () => {
  it("returns the thread ID unchanged", () => {
    const adapter = cloudAdapter();
    expect(
      adapter.channelIdFromThreadId("imessage:iMessage;-;+1234567890")
    ).toBe("imessage:iMessage;-;+1234567890");
  });

  it("passes through an empty string", () => {
    expect(cloudAdapter().channelIdFromThreadId("")).toBe("");
  });

  it("round-trips arbitrary values", () => {
    const adapter = cloudAdapter();
    for (const id of [
      "imessage:iMessage;+;chat493787071395575843",
      "guid:ABC-123",
      "  spaced  ",
    ]) {
      expect(adapter.channelIdFromThreadId(id)).toBe(id);
    }
  });
});

describe("handleWebhook", () => {
  it("routes a signed message delivery to processMessage", async () => {
    const adapter = webhookAdapter();
    await init(adapter);

    const response = await adapter.handleWebhook(
      signedWebhookRequest({ body: textMessagePayload() }),
      { waitUntil: vi.fn() }
    );

    expect(response.status).toBe(200);
    expect(mockChat.processMessage).toHaveBeenCalledWith(
      adapter,
      "imessage:iMessage;-;+1234567890",
      expect.objectContaining({ text: "hey from webhook" }),
      expect.objectContaining({ waitUntil: expect.any(Function) })
    );
  });

  it("surfaces attachments from a group delivery", async () => {
    const adapter = webhookAdapter();
    await init(adapter);

    await adapter.handleWebhook(
      signedWebhookRequest({
        body: textMessagePayload({
          chatGuid: "iMessage;+;chat123456",
          content: {
            type: "group",
            items: [
              { content: { type: "text", text: "Photo" } },
              {
                content: {
                  type: "attachment",
                  name: "photo.jpg",
                  mimeType: "image/jpeg",
                  size: 54_321,
                },
              },
            ],
          },
        }),
      })
    );

    const message = mockChat.processMessage.mock.calls[0]?.[2];
    expect(message.text).toBe("Photo");
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0].type).toBe("image");
  });

  it("rejects a bad signature with 401", async () => {
    const adapter = webhookAdapter();
    await init(adapter);

    const response = await adapter.handleWebhook(
      signedWebhookRequest({
        body: textMessagePayload(),
        signature: "v0=deadbeef",
      })
    );

    expect(response.status).toBe(401);
    expect(mockChat.processMessage).not.toHaveBeenCalled();
  });

  it("rejects a delivery with no signature headers (400)", async () => {
    const adapter = webhookAdapter();
    await init(adapter);

    const response = await adapter.handleWebhook(
      new Request("https://example.com/api/imessage/webhook", {
        method: "POST",
        headers: { "x-spectrum-event": "messages" },
        body: JSON.stringify(textMessagePayload()),
      })
    );

    expect(response.status).toBe(400);
    expect(mockChat.processMessage).not.toHaveBeenCalled();
  });

  it("rejects a stale timestamp with 400", async () => {
    const adapter = webhookAdapter();
    await init(adapter);

    const response = await adapter.handleWebhook(
      signedWebhookRequest({
        body: textMessagePayload(),
        timestamp: Math.floor(Date.now() / 1000) - 10 * 60,
      })
    );

    expect(response.status).toBe(400);
    expect(mockChat.processMessage).not.toHaveBeenCalled();
  });

  it("returns 500 when no signing secret is configured", async () => {
    const adapter = cloudAdapter(); // no webhookSecret
    await init(adapter);

    const response = await adapter.handleWebhook(
      signedWebhookRequest({ body: textMessagePayload() })
    );

    expect(response.status).toBe(500);
  });

  it("returns 500 without a chat instance", async () => {
    const response = await webhookAdapter().handleWebhook(
      signedWebhookRequest({ body: textMessagePayload() })
    );
    expect(response.status).toBe(500);
  });

  it("acknowledges non-message events with 204", async () => {
    const adapter = webhookAdapter();
    await init(adapter);

    const response = await adapter.handleWebhook(
      signedWebhookRequest({ body: textMessagePayload(), event: "reactions" })
    );

    expect(response.status).toBe(204);
    expect(mockChat.processMessage).not.toHaveBeenCalled();
  });

  it("ignores the bot's own (outbound) deliveries", async () => {
    const adapter = webhookAdapter();
    await init(adapter);

    const response = await adapter.handleWebhook(
      signedWebhookRequest({
        body: textMessagePayload({ direction: "outbound" }),
      })
    );

    expect(response.status).toBe(200);
    expect(mockChat.processMessage).not.toHaveBeenCalled();
  });

  it("ignores inbound reactions", async () => {
    const adapter = webhookAdapter();
    await init(adapter);

    const response = await adapter.handleWebhook(
      signedWebhookRequest({
        body: textMessagePayload({
          content: { type: "reaction", emoji: "❤️", target: { id: "m1" } },
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(mockChat.processMessage).not.toHaveBeenCalled();
  });

  it("ignores group-event deliveries (rename, membership, avatar)", async () => {
    const adapter = webhookAdapter();
    await init(adapter);

    for (const type of ["rename", "addMember", "removeMember", "avatar"]) {
      const response = await adapter.handleWebhook(
        signedWebhookRequest({
          body: textMessagePayload({ content: { type } }),
        })
      );
      expect(response.status).toBe(200);
    }
    expect(mockChat.processMessage).not.toHaveBeenCalled();
  });

  it("lets the bot reply to a webhook-delivered DM", async () => {
    const adapter = webhookAdapter();
    await init(adapter);

    // Inbound DM via webhook — no live Space is cached.
    await adapter.handleWebhook(
      signedWebhookRequest({
        body: textMessagePayload({ chatGuid: "any;-;+15550100" }),
      })
    );
    const threadId = mockChat.processMessage.mock.calls[0]?.[1] as string;
    expect(threadId).toBe("imessage:any;-;+15550100");

    // Reply: the adapter rebuilds the Space from the chat GUID and sends.
    const replySpace = makeSpace("any;-;+15550100", "dm", { id: "reply-1" });
    const spaceResolver = vi.fn(async () => replySpace);
    mockImessage.mockReturnValue({ space: { get: spaceResolver } });

    const result = await adapter.postMessage(threadId, "hi back");

    expect(spaceResolver).toHaveBeenCalledWith("any;-;+15550100");
    expect(replySpace.send).toHaveBeenCalledWith({
      __kind: "text",
      text: "hi back",
    });
    expect(result.id).toBe("reply-1");
  });
});

describe("startGatewayListener", () => {
  it("returns 500 without a chat instance", async () => {
    const response = await cloudAdapter().startGatewayListener({
      waitUntil: vi.fn(),
    });
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Chat instance not initialized");
  });

  it("returns 500 without waitUntil", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    const response = await adapter.startGatewayListener({});
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("waitUntil not provided");
  });

  it("starts listening and returns a success response", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    const { response, waitUntil } = await startTrackedListener(adapter, 5000);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe("listening");
    expect(body.durationMs).toBe(5000);
    expect(body.mode).toBe("remote");
    expect(waitUntil).toHaveBeenCalledOnce();
  });

  it("routes inbound messages to chat.processMessage", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    await primeInbound(adapter, { chatGuid: "iMessage;-;+1234567890" });
    expect(mockChat.processMessage).toHaveBeenCalledWith(
      adapter,
      "imessage:iMessage;-;+1234567890",
      expect.objectContaining({ text: "hi" }),
      expect.anything()
    );
  });

  it("closes the message stream on abort", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    const { controller, promise } = await startTrackedListener(adapter);

    controller.abort();
    await promise;

    expect(iteratorReturnSpy).toHaveBeenCalled();
  });

  it("ignores the sender's own (outbound) messages", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    const space = makeSpace("iMessage;-;+1234567890");
    await startTrackedListener(adapter);

    pushInbound([
      space,
      makeMessage(
        "out-1",
        space,
        { type: "text", text: "mine" },
        {
          direction: "outbound",
        }
      ),
    ]);
    pushInbound([
      space,
      makeMessage("in-2", space, { type: "text", text: "theirs" }),
    ]);

    await vi.waitFor(() => expect(mockChat.processMessage).toHaveBeenCalled());
    expect(mockChat.processMessage).toHaveBeenCalledTimes(1);
    expect(mockChat.processMessage).toHaveBeenCalledWith(
      adapter,
      expect.any(String),
      expect.objectContaining({ text: "theirs" }),
      expect.anything()
    );
  });

  // spectrum-ts v9+ delivers group events (membership, rename, avatar) on
  // app.messages — they must not surface to the bot as phantom messages.
  it("ignores inbound group-event content (rename, membership, avatar)", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    const space = makeSpace("chat-group-1", "group");
    await startTrackedListener(adapter);

    pushInbound([space, makeMessage("ev-1", space, { type: "rename" })]);
    pushInbound([space, makeMessage("ev-2", space, { type: "addMember" })]);
    pushInbound([space, makeMessage("ev-3", space, { type: "avatar" })]);
    pushInbound([
      space,
      makeMessage("in-4", space, { type: "text", text: "real one" }),
    ]);

    await vi.waitFor(() => expect(mockChat.processMessage).toHaveBeenCalled());
    expect(mockChat.processMessage).toHaveBeenCalledTimes(1);
    expect(mockChat.processMessage).toHaveBeenCalledWith(
      adapter,
      expect.any(String),
      expect.objectContaining({ text: "real one" }),
      expect.anything()
    );
  });
});

describe("postMessage", () => {
  it("sends text via the cached Space", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    const { space } = await primeInbound(adapter, {
      chatGuid: "iMessage;-;+1234567890",
      sendResult: { id: "remote-msg-001" },
    });

    const result = await adapter.postMessage(
      "imessage:iMessage;-;+1234567890",
      "Hello!"
    );

    expect(space.send).toHaveBeenCalledWith({ __kind: "text", text: "Hello!" });
    expect(result.id).toBe("remote-msg-001");
    expect(result.threadId).toBe("imessage:iMessage;-;+1234567890");
  });

  it("sends markdown-typed content as native markdown (styled on remote iMessage)", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    const { space } = await primeInbound(adapter, {
      chatGuid: "iMessage;-;+1234567890",
      sendResult: { id: "remote-msg-md" },
    });

    const result = await adapter.postMessage(
      "imessage:iMessage;-;+1234567890",
      {
        markdown: "**bold** and _italic_",
      }
    );

    // Markdown source is preserved verbatim and sent via spectrum's markdown()
    // builder rather than stripped to plain text.
    expect(space.send).toHaveBeenCalledWith({
      __kind: "markdown",
      markdown: "**bold** and _italic_",
    });
    expect(result.id).toBe("remote-msg-md");
  });

  it("sends plain string content as text, leaving stray markers untouched", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    const { space } = await primeInbound(adapter, {
      chatGuid: "iMessage;-;+1234567890",
      sendResult: { id: "remote-msg-raw" },
    });

    // A raw string is pass-through-as-is: `*` must NOT be reinterpreted as
    // markdown, so it stays plain text().
    await adapter.postMessage("imessage:iMessage;-;+1234567890", "2 * 3 = 6");

    expect(space.send).toHaveBeenCalledWith({
      __kind: "text",
      text: "2 * 3 = 6",
    });
  });

  it("cold-sends to a DM not seen this session by rebuilding it from its chat GUID", async () => {
    const adapter = cloudAdapter();
    await init(adapter);

    const coldSpace = makeSpace("any;-;+1999999999", "dm", {
      id: "cold-msg-1",
    });
    const spaceResolver = vi.fn(async () => coldSpace);
    mockImessage.mockReturnValue({ space: { get: spaceResolver } });

    const result = await adapter.postMessage(
      "imessage:any;-;+1999999999",
      "Hi"
    );

    expect(spaceResolver).toHaveBeenCalledWith("any;-;+1999999999");
    expect(coldSpace.send).toHaveBeenCalledWith({ __kind: "text", text: "Hi" });
    expect(result.id).toBe("cold-msg-1");
  });

  it("cold-sends to an unseen group thread by rebuilding it from its chat GUID", async () => {
    const adapter = cloudAdapter();
    await init(adapter);

    const coldGroup = makeSpace("iMessage;+;chatUNSEEN", "group", {
      id: "cold-group-msg-1",
    });
    const spaceResolver = vi.fn(async () => coldGroup);
    mockImessage.mockReturnValue({ space: { get: spaceResolver } });

    const result = await adapter.postMessage(
      "imessage:iMessage;+;chatUNSEEN",
      "Hi"
    );

    expect(spaceResolver).toHaveBeenCalledWith("iMessage;+;chatUNSEEN");
    expect(coldGroup.send).toHaveBeenCalledWith({ __kind: "text", text: "Hi" });
    expect(result.id).toBe("cold-group-msg-1");
  });

  it("throws NotImplementedError when the thread cannot be rebuilt", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    // e.g. multiple iMessage lines configured: spectrum-ts's `space.get`
    // cannot infer the sending line and rejects.
    mockImessage.mockReturnValue({
      space: {
        get: vi.fn(async () => {
          throw new Error("iMessage space.get requires params.phone");
        }),
      },
    });
    await expect(
      adapter.postMessage("imessage:iMessage;+;chatUNSEEN", "Hi")
    ).rejects.toThrow(NotImplementedError);
  });

  it("rebuilds an uncached webhook thread on the sending line the delivery named", async () => {
    const adapter = webhookAdapter();
    await init(adapter);

    // A webhook delivery caches no live Space, only the sending line (phone).
    const chatGuid = "iMessage;-;+1234567890";
    await adapter.handleWebhook(
      signedWebhookRequest({
        body: textMessagePayload({ chatGuid, phone: "+15550001111" }),
      })
    );

    const rebuilt = makeSpace(chatGuid, "dm", { id: "wh-reply-1" });
    const spaceResolver = vi.fn(async () => rebuilt);
    mockImessage.mockReturnValue({ space: { get: spaceResolver } });

    const result = await adapter.postMessage(`imessage:${chatGuid}`, "Hi");

    // With multiple lines configured, `space.get` needs the phone to pick one.
    expect(spaceResolver).toHaveBeenCalledWith(chatGuid, {
      phone: "+15550001111",
    });
    expect(rebuilt.send).toHaveBeenCalledWith({ __kind: "text", text: "Hi" });
    expect(result.id).toBe("wh-reply-1");
  });

  it("posts a reply without initialize() by building the app on demand", async () => {
    // The reported production bug: eve's workflow reply callback (message.completed
    // → postMessage) runs in an invocation where initialize() never ran, so the
    // adapter must build its Spectrum app on demand instead of throwing.
    const adapter = cloudAdapter();
    // Deliberately NO init(adapter).

    const chatGuid = "iMessage;-;+12094503665";
    const rebuilt = makeSpace(chatGuid, "dm", { id: "cold-init-1" });
    mockImessage.mockReturnValue({
      space: { get: vi.fn(async () => rebuilt) },
    });

    const result = await adapter.postMessage(
      `imessage:${chatGuid}~shared`,
      "Hi"
    );

    expect(mockSpectrum).toHaveBeenCalled();
    expect(rebuilt.send).toHaveBeenCalledWith({ __kind: "text", text: "Hi" });
    expect(result.id).toBe("cold-init-1");
  });

  it("rebuilds a cold-cache thread from the line encoded in the thread ID", async () => {
    // Simulates the Vercel Workflow reply callback: a *separate* invocation with
    // an empty cache. The only carried-over state is the thread ID, which must
    // encode the sending line so the rebuild picks the right one.
    const adapter = cloudAdapter();
    await init(adapter);

    const chatGuid = "iMessage;-;+1234567890";
    const rebuilt = makeSpace(chatGuid, "dm", { id: "wf-reply-1" });
    const spaceResolver = vi.fn(async () => rebuilt);
    mockImessage.mockReturnValue({ space: { get: spaceResolver } });

    // No inbound was processed in this "process" — cache is cold.
    const result = await adapter.postMessage(
      `imessage:${chatGuid}~+15550001111`,
      "Hi"
    );

    expect(spaceResolver).toHaveBeenCalledWith(chatGuid, {
      phone: "+15550001111",
    });
    expect(rebuilt.send).toHaveBeenCalledWith({ __kind: "text", text: "Hi" });
    expect(result.id).toBe("wf-reply-1");
  });

  it("throws when there is nothing to send (empty text, no files)", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    await primeInbound(adapter, { chatGuid: "iMessage;-;+1234567890" });
    await expect(
      adapter.postMessage("imessage:iMessage;-;+1234567890", "")
    ).rejects.toThrow("postMessage requires non-empty text");
  });
});

describe("sendEffect", () => {
  it("wraps text with the resolved effect id (friendly name)", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    const { space } = await primeInbound(adapter, {
      chatGuid: "iMessage;-;+1234567890",
      sendResult: { id: "effect-msg-1" },
    });

    const result = await adapter.sendEffect(
      "imessage:iMessage;-;+1234567890",
      "🎉 Task complete!",
      "confetti"
    );

    expect(space.send).toHaveBeenCalledWith({
      __kind: "effect",
      content: { __kind: "text", text: "🎉 Task complete!" },
      effect: "com.apple.messages.effect.CKConfettiEffect",
    });
    expect(result.id).toBe("effect-msg-1");
    expect(result.threadId).toBe("imessage:iMessage;-;+1234567890");
  });

  it("accepts a raw spectrum-ts effect id", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    const { space } = await primeInbound(adapter, {
      chatGuid: "iMessage;-;+1234567890",
    });

    await adapter.sendEffect(
      "imessage:iMessage;-;+1234567890",
      "boom",
      "com.apple.MobileSMS.expressivesend.impact"
    );

    expect(space.send).toHaveBeenCalledWith({
      __kind: "effect",
      content: { __kind: "text", text: "boom" },
      effect: "com.apple.MobileSMS.expressivesend.impact",
    });
  });

  it("applies the effect to markdown-typed content", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    const { space } = await primeInbound(adapter, {
      chatGuid: "iMessage;-;+1234567890",
    });

    await adapter.sendEffect(
      "imessage:iMessage;-;+1234567890",
      { markdown: "**done**" },
      "fireworks"
    );

    expect(space.send).toHaveBeenCalledWith({
      __kind: "effect",
      content: { __kind: "markdown", markdown: "**done**" },
      effect: "com.apple.messages.effect.CKFireworksEffect",
    });
  });

  it("throws ValidationError on an unknown effect", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    await primeInbound(adapter, { chatGuid: "iMessage;-;+1234567890" });

    await expect(
      adapter.sendEffect(
        "imessage:iMessage;-;+1234567890",
        "hi",
        "sparkle" as never
      )
    ).rejects.toThrow(ValidationError);
  });

  it("throws when there is no text to attach the effect to", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    await primeInbound(adapter, { chatGuid: "iMessage;-;+1234567890" });

    await expect(
      adapter.sendEffect("imessage:iMessage;-;+1234567890", "", "confetti")
    ).rejects.toThrow("sendEffect requires non-empty text");
  });
});

describe("sendMiniApp", () => {
  const sampleCard = {
    appName: "Poll Kit",
    teamId: "TEAM123",
    extensionBundleId: "com.example.pollkit.MessagesExtension",
    url: "https://example.com/poll/42",
    layout: {
      caption: "Pizza night?",
      subcaption: "Tap to vote",
      summary: "Vote on Friday's dinner",
    },
  };

  it("sends the lightweight app(url) card from a bare URL string", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    const { space } = await primeInbound(adapter, {
      chatGuid: "iMessage;-;+1234567890",
      sendResult: { id: "app-url-1" },
    });

    const result = await adapter.sendMiniApp(
      "imessage:iMessage;-;+1234567890",
      "https://example.com/menu"
    );

    expect(space.send).toHaveBeenCalledWith({
      __kind: "app",
      url: "https://example.com/menu",
    });
    expect(result.id).toBe("app-url-1");
  });

  it("passes a thunk URL straight through to app()", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    const { space } = await primeInbound(adapter, {
      chatGuid: "iMessage;-;+1234567890",
    });

    const thunk = () => "https://example.com/signed";
    await adapter.sendMiniApp("imessage:iMessage;-;+1234567890", thunk);

    expect(space.send).toHaveBeenCalledWith({ __kind: "app", url: thunk });
  });

  it("sends a customized mini-app card via the cached Space", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    const { space } = await primeInbound(adapter, {
      chatGuid: "iMessage;-;+1234567890",
      sendResult: { id: "mini-app-1" },
    });

    const result = await adapter.sendMiniApp(
      "imessage:iMessage;-;+1234567890",
      sampleCard
    );

    expect(space.send).toHaveBeenCalledWith({
      __kind: "mini-app",
      input: expect.objectContaining({
        appName: "Poll Kit",
        teamId: "TEAM123",
        extensionBundleId: "com.example.pollkit.MessagesExtension",
        url: "https://example.com/poll/42",
        layout: expect.objectContaining({
          caption: "Pizza night?",
          subcaption: "Tap to vote",
          summary: "Vote on Friday's dinner",
        }),
      }),
    });
    expect(result.id).toBe("mini-app-1");
    expect(result.threadId).toBe("imessage:iMessage;-;+1234567890");
  });

  it("normalizes a URL instance and forwards appStoreId", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    const { space } = await primeInbound(adapter, {
      chatGuid: "iMessage;-;+1234567890",
    });

    await adapter.sendMiniApp("imessage:iMessage;-;+1234567890", {
      ...sampleCard,
      url: new URL("https://example.com/poll/42"),
      appStoreId: 123_456,
    });

    const sent = space.send.mock.calls[0]?.[0] as {
      input: { url: string; appStoreId?: number };
    };
    expect(sent.input.url).toBe("https://example.com/poll/42");
    expect(sent.input.appStoreId).toBe(123_456);
  });

  it("decodes a Blob image to bytes", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    const { space } = await primeInbound(adapter, {
      chatGuid: "iMessage;-;+1234567890",
    });

    await adapter.sendMiniApp("imessage:iMessage;-;+1234567890", {
      ...sampleCard,
      layout: {
        ...sampleCard.layout,
        image: new Blob([new Uint8Array([1, 2, 3])]),
      },
    });

    const sent = space.send.mock.calls[0]?.[0] as {
      input: { layout: { image?: Uint8Array } };
    };
    expect(sent.input.layout.image).toBeInstanceOf(Uint8Array);
    expect(Array.from(sent.input.layout.image ?? [])).toEqual([1, 2, 3]);
  });

  it("copies raw bytes into a fresh, detached Uint8Array", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    const { space } = await primeInbound(adapter, {
      chatGuid: "iMessage;-;+1234567890",
    });

    const source = new Uint8Array([9, 8, 7]);
    await adapter.sendMiniApp("imessage:iMessage;-;+1234567890", {
      ...sampleCard,
      layout: { image: source },
    });

    const sent = space.send.mock.calls[0]?.[0] as {
      input: { layout: { image?: Uint8Array } };
    };
    // Same bytes, but a detached copy — not the caller's buffer.
    expect(Array.from(sent.input.layout.image ?? [])).toEqual([9, 8, 7]);
    expect(sent.input.layout.image).not.toBe(source);
  });

  it("throws ValidationError on a missing required field", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    await primeInbound(adapter, { chatGuid: "iMessage;-;+1234567890" });

    await expect(
      adapter.sendMiniApp("imessage:iMessage;-;+1234567890", {
        ...sampleCard,
        teamId: "",
      })
    ).rejects.toThrow('Mini-app card requires a non-empty "teamId"');
  });

  it("throws ValidationError on an invalid url", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    await primeInbound(adapter, { chatGuid: "iMessage;-;+1234567890" });

    await expect(
      adapter.sendMiniApp("imessage:iMessage;-;+1234567890", {
        ...sampleCard,
        url: "not a url",
      })
    ).rejects.toThrow("invalid url");
  });
});

describe("sendVoice", () => {
  const THREAD = "imessage:iMessage;-;+1234567890";

  it("sends raw bytes as a voice note with an explicit MIME type", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    const { space } = await primeInbound(adapter, {
      chatGuid: "iMessage;-;+1234567890",
      sendResult: { id: "voice-1" },
    });

    const result = await adapter.sendVoice(THREAD, new Uint8Array([1, 2, 3]), {
      mimeType: "audio/mp4",
      duration: 4,
    });

    const sent = space.send.mock.calls[0]?.[0] as {
      __kind: string;
      input: Buffer;
      options: { mimeType: string; duration?: number };
    };
    expect(sent.__kind).toBe("voice");
    expect(Buffer.isBuffer(sent.input)).toBe(true);
    expect(Array.from(sent.input)).toEqual([1, 2, 3]);
    expect(sent.options.mimeType).toBe("audio/mp4");
    expect(sent.options.duration).toBe(4);
    expect(result.id).toBe("voice-1");
    expect(result.threadId).toBe(THREAD);
  });

  it("copies raw bytes into a fresh, detached Buffer", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    const { space } = await primeInbound(adapter, {
      chatGuid: "iMessage;-;+1234567890",
    });

    const source = new Uint8Array([9, 8, 7]);
    await adapter.sendVoice(THREAD, source, { mimeType: "audio/mp4" });

    const sent = space.send.mock.calls[0]?.[0] as { input: Buffer };
    expect(Array.from(sent.input)).toEqual([9, 8, 7]);
    expect(sent.input.buffer).not.toBe(source.buffer);
  });

  it("infers an audio MIME type from an audio file name", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    const { space } = await primeInbound(adapter, {
      chatGuid: "iMessage;-;+1234567890",
    });

    await adapter.sendVoice(THREAD, new Uint8Array([1]), {
      name: "reply.m4a",
    });

    const sent = space.send.mock.calls[0]?.[0] as {
      options: { mimeType: string; name?: string };
    };
    expect(sent.options.mimeType).toBe("audio/mp4");
    expect(sent.options.name).toBe("reply.m4a");
  });

  it("decodes a Blob and takes its MIME type", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    const { space } = await primeInbound(adapter, {
      chatGuid: "iMessage;-;+1234567890",
    });

    await adapter.sendVoice(
      THREAD,
      new Blob([new Uint8Array([4, 5, 6])], { type: "audio/aac" })
    );

    const sent = space.send.mock.calls[0]?.[0] as {
      input: Buffer;
      options: { mimeType: string };
    };
    expect(Array.from(sent.input)).toEqual([4, 5, 6]);
    expect(sent.options.mimeType).toBe("audio/aac");
  });

  it("unwraps a Chat SDK FileUpload's data and metadata", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    const { space } = await primeInbound(adapter, {
      chatGuid: "iMessage;-;+1234567890",
    });

    await adapter.sendVoice(THREAD, {
      data: Buffer.from([7, 7]),
      filename: "note.m4a",
      mimeType: "audio/mp4",
    } as never);

    const sent = space.send.mock.calls[0]?.[0] as {
      input: Buffer;
      options: { mimeType: string; name?: string };
    };
    expect(Array.from(sent.input)).toEqual([7, 7]);
    expect(sent.options.mimeType).toBe("audio/mp4");
    expect(sent.options.name).toBe("note.m4a");
  });

  it("passes an http(s) URL through to voice() for send-time fetch", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    const { space } = await primeInbound(adapter, {
      chatGuid: "iMessage;-;+1234567890",
    });

    await adapter.sendVoice(THREAD, "https://example.com/speech.mp3");

    const sent = space.send.mock.calls[0]?.[0] as {
      __kind: string;
      input: URL;
    };
    expect(sent.__kind).toBe("voice");
    expect(sent.input).toBeInstanceOf(URL);
    expect(sent.input.href).toBe("https://example.com/speech.mp3");
  });

  it("throws ValidationError when the MIME type can't be resolved", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    await primeInbound(adapter, { chatGuid: "iMessage;-;+1234567890" });

    await expect(
      adapter.sendVoice(THREAD, new Uint8Array([1]))
    ).rejects.toThrow("requires an audio/* MIME type");
  });

  it("throws ValidationError on a non-audio MIME type", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    await primeInbound(adapter, { chatGuid: "iMessage;-;+1234567890" });

    await expect(
      adapter.sendVoice(THREAD, new Uint8Array([1]), { mimeType: "video/mp4" })
    ).rejects.toThrow('audio/* MIME type, got "video/mp4"');
  });

  it("throws ValidationError on a non-http(s) string input", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    await primeInbound(adapter, { chatGuid: "iMessage;-;+1234567890" });

    await expect(adapter.sendVoice(THREAD, "not a url")).rejects.toThrow(
      "must be an http(s) URL"
    );
  });
});

describe("setBackground", () => {
  const THREAD = "imessage:iMessage;-;+1234567890";

  it("sets the background from raw bytes with an explicit MIME type", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    const { space } = await primeInbound(adapter, {
      chatGuid: "iMessage;-;+1234567890",
    });

    const result = await adapter.setBackground(
      THREAD,
      new Uint8Array([1, 2, 3]),
      {
        mimeType: "image/jpeg",
      }
    );

    const sent = space.send.mock.calls[0]?.[0] as {
      __kind: string;
      input: Buffer;
      options: { mimeType: string };
    };
    expect(sent.__kind).toBe("background");
    expect(Buffer.isBuffer(sent.input)).toBe(true);
    expect(Array.from(sent.input)).toEqual([1, 2, 3]);
    expect(sent.options.mimeType).toBe("image/jpeg");
    // Fire-and-forget: no message id surfaced.
    expect(result).toBeUndefined();
  });

  it("copies raw bytes into a fresh, detached Buffer", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    const { space } = await primeInbound(adapter, {
      chatGuid: "iMessage;-;+1234567890",
    });

    const source = new Uint8Array([9, 8, 7]);
    await adapter.setBackground(THREAD, source, { mimeType: "image/png" });

    const sent = space.send.mock.calls[0]?.[0] as { input: Buffer };
    expect(Array.from(sent.input)).toEqual([9, 8, 7]);
    expect(sent.input.buffer).not.toBe(source.buffer);
  });

  it("infers an image MIME type from an image file name", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    const { space } = await primeInbound(adapter, {
      chatGuid: "iMessage;-;+1234567890",
    });

    await adapter.setBackground(THREAD, new Uint8Array([1]), {
      name: "wallpaper.png",
    });

    const sent = space.send.mock.calls[0]?.[0] as {
      options: { mimeType: string };
    };
    expect(sent.options.mimeType).toBe("image/png");
  });

  it("decodes a Blob and takes its MIME type", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    const { space } = await primeInbound(adapter, {
      chatGuid: "iMessage;-;+1234567890",
    });

    await adapter.setBackground(
      THREAD,
      new Blob([new Uint8Array([4, 5, 6])], { type: "image/webp" })
    );

    const sent = space.send.mock.calls[0]?.[0] as {
      input: Buffer;
      options: { mimeType: string };
    };
    expect(Array.from(sent.input)).toEqual([4, 5, 6]);
    expect(sent.options.mimeType).toBe("image/webp");
  });

  it("unwraps a Chat SDK FileUpload's data and metadata", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    const { space } = await primeInbound(adapter, {
      chatGuid: "iMessage;-;+1234567890",
    });

    await adapter.setBackground(THREAD, {
      data: Buffer.from([7, 7]),
      filename: "bg.png",
      mimeType: "image/png",
    } as never);

    const sent = space.send.mock.calls[0]?.[0] as {
      input: Buffer;
      options: { mimeType: string };
    };
    expect(Array.from(sent.input)).toEqual([7, 7]);
    expect(sent.options.mimeType).toBe("image/png");
  });

  it('clears the background via the "clear" sentinel', async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    const { space } = await primeInbound(adapter, {
      chatGuid: "iMessage;-;+1234567890",
    });

    await adapter.setBackground(THREAD, "clear");

    const sent = space.send.mock.calls[0]?.[0] as {
      __kind: string;
      input: string;
      options: unknown;
    };
    expect(sent.__kind).toBe("background");
    expect(sent.input).toBe("clear");
    expect(sent.options).toBeUndefined();
  });

  it("passes an http(s) URL through to background() for send-time fetch", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    const { space } = await primeInbound(adapter, {
      chatGuid: "iMessage;-;+1234567890",
    });

    await adapter.setBackground(THREAD, "https://example.com/wallpaper.jpg");

    const sent = space.send.mock.calls[0]?.[0] as {
      __kind: string;
      input: URL;
      options: unknown;
    };
    expect(sent.__kind).toBe("background");
    expect(sent.input).toBeInstanceOf(URL);
    expect(sent.input.href).toBe("https://example.com/wallpaper.jpg");
    expect(sent.options).toBeUndefined();
  });

  it("throws ValidationError when the MIME type can't be resolved", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    await primeInbound(adapter, { chatGuid: "iMessage;-;+1234567890" });

    await expect(
      adapter.setBackground(THREAD, new Uint8Array([1]))
    ).rejects.toThrow("requires an image/* MIME type");
  });

  it("throws ValidationError on a non-image MIME type", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    await primeInbound(adapter, { chatGuid: "iMessage;-;+1234567890" });

    await expect(
      adapter.setBackground(THREAD, new Uint8Array([1]), {
        mimeType: "audio/mp4",
      })
    ).rejects.toThrow('image/* MIME type, got "audio/mp4"');
  });

  it("throws ValidationError on a non-http(s) string input", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    await primeInbound(adapter, { chatGuid: "iMessage;-;+1234567890" });

    await expect(adapter.setBackground(THREAD, "./local.png")).rejects.toThrow(
      "must be an http(s) URL"
    );
  });
});

describe("editMessage", () => {
  it("edits a cached message via spectrum-ts", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    const { message } = await primeInbound(adapter, {
      chatGuid: "iMessage;-;+1234567890",
      messageId: "msg-guid-001",
    });

    const result = await adapter.editMessage(
      "imessage:iMessage;-;+1234567890",
      "msg-guid-001",
      "Updated text"
    );

    expect(message.edit).toHaveBeenCalledWith({
      __kind: "text",
      text: "Updated text",
    });
    expect(result.id).toBe("msg-guid-001");
  });

  it("edits with markdown-typed content as native markdown", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    const { message } = await primeInbound(adapter, {
      chatGuid: "iMessage;-;+1234567890",
      messageId: "msg-guid-md",
    });

    await adapter.editMessage(
      "imessage:iMessage;-;+1234567890",
      "msg-guid-md",
      { markdown: "**updated**" }
    );

    expect(message.edit).toHaveBeenCalledWith({
      __kind: "markdown",
      markdown: "**updated**",
    });
  });

  it("throws NotImplementedError when the message was not seen this session", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    await expect(
      adapter.editMessage("imessage:iMessage;-;+1234567890", "unknown", "x")
    ).rejects.toThrow(NotImplementedError);
  });
});

describe("addReaction / removeReaction", () => {
  it("reacts with the mapped emoji glyph", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    const { message } = await primeInbound(adapter, {
      chatGuid: "iMessage;-;+1234567890",
      messageId: "msg-001",
    });

    await adapter.addReaction(
      "imessage:iMessage;-;+1234567890",
      "msg-001",
      "thumbs_up"
    );
    expect(message.react).toHaveBeenCalledWith("👍");
  });

  it("throws for an unsupported emoji", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    await primeInbound(adapter, {
      chatGuid: "iMessage;-;+1234567890",
      messageId: "msg-001",
    });
    await expect(
      adapter.addReaction("imessage:iMessage;-;+1234567890", "msg-001", "fire")
    ).rejects.toThrow('Unsupported iMessage tapback: "fire"');
  });

  it("removes a reaction added earlier this session by unsending it", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    const { message } = await primeInbound(adapter, {
      chatGuid: "iMessage;-;+1234567890",
      messageId: "msg-001",
    });
    const reaction = makeReaction("reaction-1", message.space);
    message.react.mockResolvedValueOnce(reaction);

    await adapter.addReaction(
      "imessage:iMessage;-;+1234567890",
      "msg-001",
      "heart"
    );
    await adapter.removeReaction(
      "imessage:iMessage;-;+1234567890",
      "msg-001",
      "heart"
    );

    expect(reaction.unsend).toHaveBeenCalledTimes(1);
  });

  it("throws when the reaction was not added in this session", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    await expect(
      adapter.removeReaction("imessage:iMessage;-;+1234567890", "m1", "laugh")
    ).rejects.toThrow(NotImplementedError);
  });

  it("throws for an unsupported emoji on removeReaction", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    await expect(
      adapter.removeReaction("imessage:iMessage;-;+1234567890", "m1", "fire")
    ).rejects.toThrow('Unsupported iMessage tapback: "fire"');
  });
});

describe("deleteMessage", () => {
  it("unsends a message resolved from the session cache", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    const { message } = await primeInbound(adapter, {
      chatGuid: "iMessage;-;+1234567890",
      messageId: "msg-del-1",
    });

    await adapter.deleteMessage("imessage:iMessage;-;+1234567890", "msg-del-1");
    expect(message.unsend).toHaveBeenCalledTimes(1);
  });

  it("throws when the target message can't be resolved", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    // No matching line for an unseen chat with getMessage returning undefined.
    mockImessage.mockImplementation(() => ({
      space: {
        get: vi.fn(async (id: string) => {
          const space = makeSpace(id, "dm");
          space.getMessage.mockResolvedValue(undefined);
          return space;
        }),
      },
    }));
    await expect(
      adapter.deleteMessage("imessage:iMessage;-;+1999999999", "missing")
    ).rejects.toThrow(NotImplementedError);
  });
});

describe("markRead", () => {
  it("marks a received message as read", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    const { message } = await primeInbound(adapter, {
      chatGuid: "iMessage;-;+1234567890",
      messageId: "msg-read-1",
    });

    await adapter.markRead("imessage:iMessage;-;+1234567890", "msg-read-1");
    expect(message.read).toHaveBeenCalledTimes(1);
  });
});

describe("openDM", () => {
  it("resolves a DM thread id from a handle", async () => {
    const adapter = cloudAdapter();
    await init(adapter);

    const threadId = await adapter.openDM("+15551234567");
    expect(threadId).toBe("imessage:iMessage;-;+15551234567");
  });

  it("posting into an opened DM reuses the resolved space", async () => {
    const adapter = cloudAdapter();
    await init(adapter);

    const created = makeSpace("iMessage;-;+15551234567", "dm", {
      id: "dm-sent-1",
    });
    mockImessage.mockImplementation(() => ({
      space: {
        get: vi.fn(async () => {
          throw new Error("should not rebuild — the created space is cached");
        }),
        create: vi.fn(async () => created),
      },
    }));

    const threadId = await adapter.openDM("+15551234567");
    await adapter.postMessage(threadId, "hi there");
    expect(created.send).toHaveBeenCalled();
  });

  it("lazily builds the app when eve invokes it without initialize()", async () => {
    // Simulates a cold Vercel Workflow reply invocation: eve constructs the
    // adapter from config but never runs initialize(), so the app must be
    // built on demand rather than throwing.
    const adapter = cloudAdapter();
    const threadId = await adapter.openDM("+15551234567");
    expect(mockSpectrum).toHaveBeenCalled();
    expect(threadId).toBe("imessage:iMessage;-;+15551234567");
  });
});

describe("startTyping", () => {
  it("starts typing and auto-stops after 3s", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    const { space } = await primeInbound(adapter, {
      chatGuid: "iMessage;-;+1234567890",
    });

    vi.useFakeTimers();
    await adapter.startTyping("imessage:iMessage;-;+1234567890");
    expect(space.startTyping).toHaveBeenCalled();
    expect(space.stopTyping).not.toHaveBeenCalled();

    vi.advanceTimersByTime(3000);
    expect(space.stopTyping).toHaveBeenCalled();
  });
});

describe("fetchMessage", () => {
  it("returns a parsed message resolved from the session cache", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    await primeInbound(adapter, {
      chatGuid: "iMessage;-;+1234567890",
      messageId: "msg-fetch-1",
      content: { type: "text", text: "cached hello" },
    });

    const message = await adapter.fetchMessage(
      "imessage:iMessage;-;+1234567890",
      "msg-fetch-1"
    );
    expect(message?.id).toBe("msg-fetch-1");
    expect(message?.text).toBe("cached hello");
  });

  it("returns null when the message can't be resolved", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    mockImessage.mockImplementation(() => ({
      space: {
        get: vi.fn(async (id: string) => {
          const space = makeSpace(id, "dm");
          space.getMessage.mockResolvedValue(undefined);
          return space;
        }),
      },
    }));

    const message = await adapter.fetchMessage(
      "imessage:iMessage;-;+1999999999",
      "missing"
    );
    expect(message).toBeNull();
  });
});

describe("fetchMessages / fetchThread", () => {
  it("fetchMessages throws NotImplementedError", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    await expect(
      adapter.fetchMessages("imessage:iMessage;-;+1234567890")
    ).rejects.toThrow(NotImplementedError);
  });

  it("fetchThread throws NotImplementedError", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    await expect(
      adapter.fetchThread("imessage:iMessage;-;+1234567890")
    ).rejects.toThrow(NotImplementedError);
  });
});

describe("parseMessage", () => {
  it("builds a Chat SDK message from a spectrum message", () => {
    const adapter = cloudAdapter();
    const space = makeSpace("iMessage;-;+1987654321");
    const raw = makeMessage(
      "msg-remote-001",
      space,
      { type: "text", text: "Hello from remote" },
      { sender: "+1987654321" }
    );

    const message = adapter.parseMessage(raw);
    expect(message.id).toBe("msg-remote-001");
    expect(message.text).toBe("Hello from remote");
    expect(message.author.userId).toBe("+1987654321");
    expect(message.threadId).toBe("imessage:iMessage;-;+1987654321");
    expect(message.isMention).toBe(true);
  });

  it("sets isMention false for group chats and surfaces attachments", () => {
    const adapter = cloudAdapter();
    const space = makeSpace("iMessage;+;chat123456", "group");
    const raw = makeMessage("msg-002", space, {
      type: "group",
      items: [
        { content: { type: "text", text: "Photo" } },
        {
          content: {
            type: "attachment",
            name: "photo.jpg",
            mimeType: "image/jpeg",
            size: 54_321,
          },
        },
      ],
    });

    const message = adapter.parseMessage(raw);
    expect(message.isMention).toBe(false);
    expect(message.text).toBe("Photo");
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0].type).toBe("image");
    expect(message.attachments[0].name).toBe("photo.jpg");
  });
});

describe("openModal", () => {
  const sampleModal: ModalElement = {
    type: "modal",
    callbackId: "fav-color",
    title: "Favorite color?",
    children: [
      {
        type: "select",
        id: "color",
        label: "Pick a color",
        options: [
          { label: "Red", value: "red" },
          { label: "Blue", value: "blue" },
          { label: "Green", value: "green" },
        ],
      },
    ],
  };

  it("throws ValidationError when no Select child is present", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    await primeInbound(adapter, { chatGuid: "iMessage;-;+1234567890" });
    await expect(
      adapter.openModal("imessage:iMessage;-;+1234567890", {
        type: "modal",
        callbackId: "no-select",
        title: "No select",
        children: [{ type: "text_input", id: "name", label: "Name" }],
      } as ModalElement)
    ).rejects.toThrow("openModal requires at least one Select child");
  });

  it("creates an iMessage poll from the modal", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    const { space } = await primeInbound(adapter, {
      chatGuid: "iMessage;-;+1234567890",
      sendResult: { id: "poll-001" },
    });

    const result = await adapter.openModal(
      "imessage:iMessage;-;+1234567890",
      sampleModal
    );

    expect(space.send).toHaveBeenCalledWith({
      __kind: "poll",
      title: "Favorite color?",
      options: ["Red", "Blue", "Green"],
    });
    expect(result.viewId).toBe("poll-001");
  });
});

describe("poll vote -> processModalSubmit", () => {
  const surveyModal: ModalElement = {
    type: "modal",
    callbackId: "survey",
    title: "Survey",
    privateMetadata: "ctx-meta",
    children: [
      {
        type: "select",
        id: "answer",
        label: "Answer",
        options: [
          { label: "Option A", value: "a" },
          { label: "Option B", value: "b" },
          { label: "Option C", value: "c" },
        ],
      },
    ],
  };

  it("maps a vote's option to its SelectOption value", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    const { space } = await primeInbound(adapter, {
      chatGuid: "iMessage;-;+1234567890",
      sendResult: { id: "poll-map-001" },
    });

    await adapter.openModal(
      "imessage:iMessage;-;+1234567890",
      surveyModal,
      "ctx-123"
    );

    pushInbound([
      space,
      makeMessage(
        "vote-1",
        space,
        {
          type: "poll_option",
          selected: true,
          poll: { title: "Survey", options: [] },
          option: { title: "Option C" },
        },
        { sender: "+1555555555" }
      ),
    ]);

    await vi.waitFor(() =>
      expect(mockChat.processModalSubmit).toHaveBeenCalled()
    );
    expect(mockChat.processModalSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        callbackId: "survey",
        privateMetadata: "ctx-meta",
        viewId: "poll-map-001",
        values: { answer: "c" },
        user: expect.objectContaining({ userId: "+1555555555" }),
      }),
      "ctx-123",
      expect.anything()
    );
  });

  it("ignores votes for unknown polls", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    const { space } = await primeInbound(adapter, {
      chatGuid: "iMessage;-;+1234567890",
    });

    pushInbound([
      space,
      makeMessage("vote-x", space, {
        type: "poll_option",
        selected: true,
        poll: { title: "Unknown poll", options: [] },
        option: { title: "Whatever" },
      }),
    ]);
    // A trailing text message; once it is processed (FIFO), the vote ahead of
    // it has already been handled — so a missing submit is conclusive.
    pushInbound([
      space,
      makeMessage("after-vote", space, { type: "text", text: "after" }),
    ]);
    await vi.waitFor(() =>
      expect(mockChat.processMessage).toHaveBeenCalledTimes(2)
    );
    expect(mockChat.processModalSubmit).not.toHaveBeenCalled();
  });

  it("ignores votes for an option label that is not registered", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    const { space } = await primeInbound(adapter, {
      chatGuid: "iMessage;-;+1234567890",
      sendResult: { id: "poll-bad-opt" },
    });
    await adapter.openModal(
      "imessage:iMessage;-;+1234567890",
      surveyModal,
      "ctx-123"
    );

    pushInbound([
      space,
      makeMessage("vote-bad", space, {
        type: "poll_option",
        selected: true,
        poll: { title: "Survey", options: [] },
        option: { title: "Not A Real Option" },
      }),
    ]);
    pushInbound([
      space,
      makeMessage("after-bad", space, { type: "text", text: "after" }),
    ]);
    await vi.waitFor(() =>
      expect(mockChat.processMessage).toHaveBeenCalledTimes(2)
    );
    expect(mockChat.processModalSubmit).not.toHaveBeenCalled();
  });
});

describe("deriveAddress", () => {
  it("strips scheme and defaults the port to 443", () => {
    expect(deriveAddress("https://example.com")).toBe("example.com:443");
    expect(deriveAddress("http://example.com/path")).toBe("example.com:443");
    expect(deriveAddress("example.com:8443")).toBe("example.com:8443");
    expect(deriveAddress("grpc.example.com:443")).toBe("grpc.example.com:443");
  });

  it("handles bracketed IPv6 addresses", () => {
    expect(deriveAddress("https://[2001:db8::1]")).toBe("[2001:db8::1]:443");
    expect(deriveAddress("[2001:db8::1]:8443")).toBe("[2001:db8::1]:8443");
  });
});

describe("createiMessageAdapter", () => {
  beforeEach(() => {
    // Isolate from the runner's environment so mode detection is deterministic.
    vi.stubEnv("IMESSAGE_LOCAL", undefined);
    vi.stubEnv("IMESSAGE_PROJECT_ID", undefined);
    vi.stubEnv("IMESSAGE_PROJECT_SECRET", undefined);
    vi.stubEnv("IMESSAGE_SERVER_URL", undefined);
    vi.stubEnv("IMESSAGE_API_KEY", undefined);
    vi.stubEnv("IMESSAGE_PHONE", undefined);
    vi.stubEnv("IMESSAGE_WEBHOOK_SECRET", undefined);
  });

  it("throws when the removed local mode is requested explicitly", () => {
    expect(() => createiMessageAdapter({ local: true })).toThrow(
      "Local (on-device) mode was removed"
    );
  });

  it("throws when the removed local mode is requested via IMESSAGE_LOCAL", () => {
    vi.stubEnv("IMESSAGE_LOCAL", "true");
    expect(() => createiMessageAdapter()).toThrow(
      "Local (on-device) mode was removed"
    );
  });

  it("accepts the legacy IMESSAGE_LOCAL=false opt-out as a no-op", () => {
    vi.stubEnv("IMESSAGE_LOCAL", "false");
    const adapter = createiMessageAdapter({
      projectId: "p",
      projectSecret: "s",
    });
    expect(adapter.projectId).toBe("p");
  });

  it("resolves lazy cloud credentials on initialization", async () => {
    const credentials = vi.fn(async () => ({
      projectId: "lazy-project",
      projectSecret: "lazy-secret",
    }));
    const adapter = createiMessageAdapter({ credentials });

    expect(credentials).not.toHaveBeenCalled();
    await init(adapter);

    expect(credentials).toHaveBeenCalledOnce();
    expect(mockSpectrum).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "lazy-project",
        projectSecret: "lazy-secret",
      })
    );
  });

  it("shares one lazy credential lookup across concurrent initialization", async () => {
    const credentials = vi.fn(async () => ({
      projectId: "lazy-project",
      projectSecret: "lazy-secret",
    }));
    const adapter = createiMessageAdapter({ credentials });

    await Promise.all([
      adapter.initialize(mockChat as never),
      adapter.initialize(mockChat as never),
    ]);

    expect(credentials).toHaveBeenCalledOnce();
  });

  it("uses cloud credentials when provided", () => {
    const adapter = createiMessageAdapter({
      local: false,
      projectId: "p",
      projectSecret: "s",
    });
    expect(adapter.projectId).toBe("p");
  });

  it("uses legacy serverUrl/apiKey self-host mode", () => {
    const adapter = createiMessageAdapter({
      local: false,
      serverUrl: "grpc.example.com:443",
      apiKey: "test-key",
    });
    expect(adapter.serverUrl).toBe("grpc.example.com:443");
    expect(adapter.apiKey).toBe("test-key");
  });

  it("selects cloud from credentials without an explicit flag", () => {
    const adapter = createiMessageAdapter({
      projectId: "p",
      projectSecret: "s",
    });
    expect(adapter.projectId).toBe("p");
  });

  it("selects self-host from serverUrl + apiKey without an explicit flag", () => {
    const adapter = createiMessageAdapter({
      serverUrl: "grpc.example.com:443",
      apiKey: "k",
    });
    expect(adapter.serverUrl).toBe("grpc.example.com:443");
  });

  it("trims serverUrl and apiKey passed through to the adapter", () => {
    const adapter = createiMessageAdapter({
      local: false,
      serverUrl: "  grpc.example.com:443  ",
      apiKey: "  token  ",
    });
    expect(adapter.serverUrl).toBe("grpc.example.com:443");
    expect(adapter.apiKey).toBe("token");
  });

  it("reads cloud creds from env", () => {
    vi.stubEnv("IMESSAGE_PROJECT_ID", "env-proj");
    vi.stubEnv("IMESSAGE_PROJECT_SECRET", "env-secret");
    const adapter = createiMessageAdapter();
    expect(adapter.projectId).toBe("env-proj");
  });

  it("reads and trims the webhook secret from env", () => {
    vi.stubEnv("IMESSAGE_PROJECT_ID", "env-proj");
    vi.stubEnv("IMESSAGE_PROJECT_SECRET", "env-secret");
    vi.stubEnv("IMESSAGE_WEBHOOK_SECRET", "  whsec_env  ");
    const adapter = createiMessageAdapter();
    expect(adapter.webhookSecret).toBe("whsec_env");
  });

  it("prefers a config webhook secret over env", () => {
    vi.stubEnv("IMESSAGE_WEBHOOK_SECRET", "whsec_env");
    const adapter = createiMessageAdapter({
      projectId: "p",
      projectSecret: "s",
      webhookSecret: "whsec_config",
    });
    expect(adapter.webhookSecret).toBe("whsec_config");
  });

  it("throws when remote mode has no auth at all", () => {
    expect(() => createiMessageAdapter({ local: false })).toThrow(
      ValidationError
    );
    expect(() => createiMessageAdapter({ local: false })).toThrow(
      "serverUrl is required"
    );
  });

  it("throws when self-host serverUrl is set without apiKey", () => {
    expect(() =>
      createiMessageAdapter({ local: false, serverUrl: "grpc.example.com:443" })
    ).toThrow("apiKey is required");
  });

  it("prefers config values over env vars", () => {
    vi.stubEnv("IMESSAGE_PROJECT_ID", "env-proj");
    vi.stubEnv("IMESSAGE_PROJECT_SECRET", "env-secret");
    const adapter = createiMessageAdapter({
      local: false,
      projectId: "config-proj",
      projectSecret: "config-secret",
    });
    expect(adapter.projectId).toBe("config-proj");
  });

  it("treats an empty clients array as missing config", () => {
    expect(() => createiMessageAdapter({ local: false, clients: [] })).toThrow(
      "serverUrl is required"
    );
  });

  it("treats whitespace-only serverUrl/apiKey as missing", () => {
    expect(() =>
      createiMessageAdapter({ local: false, serverUrl: "   " })
    ).toThrow("serverUrl is required");
    expect(() =>
      createiMessageAdapter({
        local: false,
        serverUrl: "grpc.example.com:443",
        apiKey: "   ",
      })
    ).toThrow("apiKey is required");
  });
});
