import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// ---------------------------------------------------------------------------
// Mocks: spectrum-ts + its iMessage provider. Content builders are replaced
// with inspectable passthroughs so we can assert on what was sent.
// ---------------------------------------------------------------------------

const { mockSpectrum, mockImessageConfig, mockImessage } = vi.hoisted(() => ({
  mockSpectrum: vi.fn(),
  mockImessageConfig: vi.fn((c: unknown) => ({ __providerConfig: c })),
  mockImessage: vi.fn(),
}));

vi.mock("spectrum-ts", () => ({
  Spectrum: mockSpectrum,
  text: (t: string) => ({ __kind: "text", text: t }),
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
}));

vi.mock("spectrum-ts/providers/imessage", () => ({
  imessage: Object.assign(mockImessage, { config: mockImessageConfig }),
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

// Local-mode construction requires macOS — pin the platform to `darwin` for the
// whole suite so it runs on any CI OS. Platform-specific tests override locally.
const REAL_PLATFORM = Object.getOwnPropertyDescriptor(process, "platform");
beforeAll(() => {
  Object.defineProperty(process, "platform", {
    value: "darwin",
    configurable: true,
  });
});
afterAll(() => {
  if (REAL_PLATFORM) {
    Object.defineProperty(process, "platform", REAL_PLATFORM);
  }
});

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
  rename: ReturnType<typeof vi.fn>;
  responding: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  startTyping: ReturnType<typeof vi.fn>;
  stopTyping: ReturnType<typeof vi.fn>;
  type: "dm" | "group";
}

interface MockMessage {
  content: unknown;
  direction: "inbound" | "outbound";
  edit: ReturnType<typeof vi.fn>;
  id: string;
  platform: string;
  react: ReturnType<typeof vi.fn>;
  reply: ReturnType<typeof vi.fn>;
  sender: { id: string; __platform: string } | undefined;
  space: MockSpace;
  timestamp: Date;
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
    react: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
    edit: vi.fn(async () => undefined),
  };
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
  } = {}
): Record<string, unknown> {
  const chatGuid = overrides.chatGuid ?? "iMessage;-;+1234567890";
  const space = { id: chatGuid, platform: "iMessage", type: "dm" };
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

function localAdapter(): iMessageAdapter {
  return new iMessageAdapter({ local: true, logger: mockLogger });
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
  // Default: `imessage(app).space([address])` resolves a DM space over gRPC.
  // Tests that assert on the resolved space override this per-case.
  mockImessage.mockReset();
  mockImessage.mockImplementation(() => ({
    space: vi.fn(async (users: string[]) => makeSpace(`any;-;${users[0]}`)),
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
    expect(localAdapter().name).toBe("imessage");
  });

  it("stores local mode config", () => {
    const adapter = localAdapter();
    expect(adapter.local).toBe(true);
    expect(adapter.app).toBeNull();
  });

  it("stores remote (self-host) config", () => {
    const adapter = new iMessageAdapter({
      local: false,
      logger: mockLogger,
      serverUrl: "grpc.example.com:443",
      apiKey: "test-key",
    });
    expect(adapter.local).toBe(false);
    expect(adapter.serverUrl).toBe("grpc.example.com:443");
    expect(adapter.apiKey).toBe("test-key");
  });

  it("stores remote (cloud) config", () => {
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

  it("throws on non-macOS platform in local mode", () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      expect(() => localAdapter()).toThrow(
        "iMessage adapter local mode requires macOS"
      );
    } finally {
      Object.defineProperty(process, "platform", { value: original });
    }
  });

  it("allows remote mode on non-macOS platforms", () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      expect(cloudAdapter().local).toBe(false);
    } finally {
      Object.defineProperty(process, "platform", { value: original });
    }
  });
});

describe("initialize", () => {
  it("builds a Spectrum instance with local provider config", async () => {
    await init(localAdapter());
    expect(mockImessageConfig).toHaveBeenCalledWith({ local: true });
    expect(mockSpectrum).toHaveBeenCalledWith({
      providers: [{ __providerConfig: { local: true } }],
    });
  });

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
    const adapter = localAdapter();
    const threadId = adapter.encodeThreadId({
      chatGuid: "iMessage;-;+1234567890",
    });
    expect(threadId).toBe("imessage:iMessage;-;+1234567890");
    expect(adapter.decodeThreadId(threadId)).toEqual({
      chatGuid: "iMessage;-;+1234567890",
    });
  });

  it("throws on a thread ID from another adapter", () => {
    expect(() => localAdapter().decodeThreadId("slack:C123")).toThrow(
      "Invalid iMessage thread ID"
    );
  });

  it("throws on an empty chat GUID", () => {
    expect(() => localAdapter().decodeThreadId("imessage:")).toThrow(
      "Invalid iMessage thread ID"
    );
  });

  it("detects DM vs group", () => {
    const adapter = localAdapter();
    expect(adapter.isDM("imessage:iMessage;-;+1234567890")).toBe(true);
    expect(adapter.isDM("imessage:iMessage;+;chat493787071395575843")).toBe(
      false
    );
    expect(adapter.isDM("imessage:SMS;-;+1234567890")).toBe(true);
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

  it("returns 501 in local mode", async () => {
    const adapter = localAdapter();
    await init(adapter);

    const response = await adapter.handleWebhook(
      new Request("https://example.com/webhook", { method: "POST", body: "{}" })
    );

    expect(response.status).toBe(501);
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

  it("lets the bot reply to a webhook-delivered DM via gRPC", async () => {
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

    // Reply: the adapter rebuilds the DM Space over gRPC and sends.
    const replySpace = makeSpace("any;-;+15550100", "dm", { id: "reply-1" });
    const spaceResolver = vi.fn(async () => replySpace);
    mockImessage.mockReturnValue({ space: spaceResolver });

    const result = await adapter.postMessage(threadId, "hi back");

    expect(spaceResolver).toHaveBeenCalledWith(["+15550100"]);
    expect(replySpace.send).toHaveBeenCalledWith({
      __kind: "text",
      text: "hi back",
    });
    expect(result.id).toBe("reply-1");
  });
});

describe("startGatewayListener", () => {
  it("returns 500 without a chat instance", async () => {
    const response = await localAdapter().startGatewayListener({
      waitUntil: vi.fn(),
    });
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Chat instance not initialized");
  });

  it("returns 500 without waitUntil", async () => {
    const adapter = localAdapter();
    await init(adapter);
    const response = await adapter.startGatewayListener({});
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("waitUntil not provided");
  });

  it("starts listening and returns a success response", async () => {
    const adapter = localAdapter();
    await init(adapter);
    const { response, waitUntil } = await startTrackedListener(adapter, 5000);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe("listening");
    expect(body.durationMs).toBe(5000);
    expect(body.mode).toBe("local");
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

  it("cold-sends to a DM not seen this session by rebuilding it over gRPC", async () => {
    const adapter = cloudAdapter();
    await init(adapter);

    const coldSpace = makeSpace("any;-;+1999999999", "dm", {
      id: "cold-msg-1",
    });
    const spaceResolver = vi.fn(async () => coldSpace);
    mockImessage.mockReturnValue({ space: spaceResolver });

    const result = await adapter.postMessage(
      "imessage:any;-;+1999999999",
      "Hi"
    );

    expect(spaceResolver).toHaveBeenCalledWith(["+1999999999"]);
    expect(coldSpace.send).toHaveBeenCalledWith({ __kind: "text", text: "Hi" });
    expect(result.id).toBe("cold-msg-1");
  });

  it("throws NotImplementedError for an unseen group thread", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    await expect(
      adapter.postMessage("imessage:iMessage;+;chatUNSEEN", "Hi")
    ).rejects.toThrow(NotImplementedError);
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

describe("editMessage", () => {
  it("throws NotImplementedError in local mode", async () => {
    const adapter = localAdapter();
    await init(adapter);
    await expect(
      adapter.editMessage("imessage:iMessage;-;+1234567890", "m1", "x")
    ).rejects.toThrow("editMessage is not supported in local mode");
  });

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

  it("throws NotImplementedError when the message was not seen this session", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    await expect(
      adapter.editMessage("imessage:iMessage;-;+1234567890", "unknown", "x")
    ).rejects.toThrow(NotImplementedError);
  });
});

describe("addReaction / removeReaction", () => {
  it("throws NotImplementedError in local mode for addReaction", async () => {
    const adapter = localAdapter();
    await init(adapter);
    await expect(
      adapter.addReaction("imessage:iMessage;-;+1234567890", "m1", "heart")
    ).rejects.toThrow("addReaction is not supported in local mode");
  });

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

  it("removeReaction always throws NotImplementedError", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    await expect(
      adapter.removeReaction("imessage:iMessage;-;+1234567890", "m1", "laugh")
    ).rejects.toThrow(NotImplementedError);
  });
});

describe("startTyping", () => {
  it("throws NotImplementedError in local mode", async () => {
    const adapter = localAdapter();
    await init(adapter);
    await expect(
      adapter.startTyping("imessage:iMessage;-;+1234567890")
    ).rejects.toThrow("startTyping is not supported in local mode");
  });

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

  it("throws NotImplementedError in local mode", async () => {
    const adapter = localAdapter();
    await init(adapter);
    await expect(
      adapter.openModal("imessage:iMessage;-;+1234567890", sampleModal)
    ).rejects.toThrow("openModal is not supported in local mode");
  });

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

  it("defaults to local mode", () => {
    expect(createiMessageAdapter().local).toBe(true);
  });

  it("uses cloud credentials when provided", () => {
    const adapter = createiMessageAdapter({
      local: false,
      projectId: "p",
      projectSecret: "s",
    });
    expect(adapter.local).toBe(false);
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

  it("selects remote (cloud) from credentials without an explicit local flag", () => {
    const adapter = createiMessageAdapter({
      projectId: "p",
      projectSecret: "s",
    });
    expect(adapter.local).toBe(false);
    expect(adapter.projectId).toBe("p");
  });

  it("selects remote (self-host) from serverUrl + apiKey without an explicit local flag", () => {
    const adapter = createiMessageAdapter({
      serverUrl: "grpc.example.com:443",
      apiKey: "k",
    });
    expect(adapter.local).toBe(false);
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
    vi.stubEnv("IMESSAGE_LOCAL", "false");
    vi.stubEnv("IMESSAGE_PROJECT_ID", "env-proj");
    vi.stubEnv("IMESSAGE_PROJECT_SECRET", "env-secret");
    const adapter = createiMessageAdapter();
    expect(adapter.local).toBe(false);
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
      "serverUrl is required when local is false"
    );
  });

  it("throws when self-host serverUrl is set without apiKey", () => {
    expect(() =>
      createiMessageAdapter({ local: false, serverUrl: "grpc.example.com:443" })
    ).toThrow("apiKey is required when local is false");
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
      "serverUrl is required when local is false"
    );
  });

  it("treats whitespace-only serverUrl/apiKey as missing", () => {
    expect(() =>
      createiMessageAdapter({ local: false, serverUrl: "   " })
    ).toThrow("serverUrl is required when local is false");
    expect(() =>
      createiMessageAdapter({
        local: false,
        serverUrl: "grpc.example.com:443",
        apiKey: "   ",
      })
    ).toThrow("apiKey is required when local is false");
  });
});
