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

const { mockSpectrum, mockImessageConfig } = vi.hoisted(() => ({
  mockSpectrum: vi.fn(),
  mockImessageConfig: vi.fn((c: unknown) => ({ __providerConfig: c })),
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
  imessage: Object.assign(vi.fn(), { config: mockImessageConfig }),
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

import { ValidationError } from "@chat-adapter/shared";
import { NotImplementedError } from "chat";
import type { ModalElement } from "chat";
import {
  createiMessageAdapter,
  deriveAddress,
  iMessageAdapter,
} from "./index";

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
  durationMs = 60000
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
  id: string;
  __platform: string;
  type: "dm" | "group";
  send: ReturnType<typeof vi.fn>;
  getMessage: ReturnType<typeof vi.fn>;
  startTyping: ReturnType<typeof vi.fn>;
  stopTyping: ReturnType<typeof vi.fn>;
  edit: ReturnType<typeof vi.fn>;
  responding: ReturnType<typeof vi.fn>;
  rename: ReturnType<typeof vi.fn>;
  avatar: ReturnType<typeof vi.fn>;
}

interface MockMessage {
  id: string;
  space: MockSpace;
  content: unknown;
  sender: { id: string; __platform: string } | undefined;
  timestamp: Date;
  platform: string;
  direction: "inbound" | "outbound";
  react: ReturnType<typeof vi.fn>;
  reply: ReturnType<typeof vi.fn>;
  edit: ReturnType<typeof vi.fn>;
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
  await vi.waitFor(() => expect(mockChat.processMessage).toHaveBeenCalled());
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
  it("returns 501 (use startGatewayListener)", async () => {
    const adapter = localAdapter();
    await init(adapter);
    const response = await adapter.handleWebhook(
      new Request("https://example.com/webhook", { method: "POST", body: "{}" })
    );
    expect(response.status).toBe(501);
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
      makeMessage("out-1", space, { type: "text", text: "mine" }, {
        direction: "outbound",
      }),
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

  it("throws NotImplementedError for a thread not seen this session", async () => {
    const adapter = cloudAdapter();
    await init(adapter);
    await expect(
      adapter.postMessage("imessage:iMessage;-;+1999999999", "Hi")
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
            size: 54321,
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

  it("reads cloud creds from env", () => {
    vi.stubEnv("IMESSAGE_LOCAL", "false");
    vi.stubEnv("IMESSAGE_PROJECT_ID", "env-proj");
    vi.stubEnv("IMESSAGE_PROJECT_SECRET", "env-secret");
    const adapter = createiMessageAdapter();
    expect(adapter.local).toBe(false);
    expect(adapter.projectId).toBe("env-proj");
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
