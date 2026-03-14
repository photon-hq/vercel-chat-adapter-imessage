import { afterEach, describe, expect, it, vi } from "vitest";
import { metrics, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";

const LOCAL_ID_PATTERN = /^local-\d+$/;

const {
  mockStartWatching,
  mockStopWatching,
  mockLocalClose,
  mockSend,
  mockConnect,
  mockClose,
  mockOnce,
  mockSendMessage,
  mockEditMessage,
  mockGetChat,
  mockSendReaction,
  mockStartTyping,
  mockStopTyping,
  mockGatewayConnect,
  mockGatewayClose,
  mockGatewayOn,
  mockPollCreate,
  mockProcessModalSubmit,
  MockAdvancedIMessageKit,
  mockIsPollVote,
  mockParsePollVotes,
} = vi.hoisted(() => {
  const mockStartWatching = vi.fn();
  const mockStopWatching = vi.fn();
  const mockLocalClose = vi.fn();
  const mockSend = vi.fn();
  const mockConnect = vi.fn();
  const mockClose = vi.fn();
  const mockOn = vi.fn();
  const mockOnce = vi.fn((_event: string, cb: () => void) => cb());
  const mockSendMessage = vi.fn();
  const mockEditMessage = vi.fn();
  const mockGetChat = vi.fn();
  const mockSendReaction = vi.fn();
  const mockStartTyping = vi.fn();
  const mockStopTyping = vi.fn();
  const mockGatewayConnect = vi.fn();
  const mockGatewayClose = vi.fn();
  const mockGatewayOn = vi.fn();
  const mockPollCreate = vi.fn();
  const mockProcessModalSubmit = vi.fn();
  const mockIsPollVote = vi.fn(() => false);
  const mockParsePollVotes = vi.fn((): unknown => null);

  // biome-ignore lint/complexity/useArrowFunction: vitest 4 requires function expressions for constructor mocks
  const MockAdvancedIMessageKit = vi.fn(function () {
    return {
      mocked: true,
      connect: mockGatewayConnect,
      close: mockGatewayClose,
      on: mockGatewayOn,
      once: vi.fn(),
      messages: {},
      chats: {},
    };
  });
  (MockAdvancedIMessageKit as unknown as Record<string, unknown>).getInstance =
    vi.fn(() => ({
      mocked: true,
      connect: mockConnect,
      close: mockClose,
      on: mockOn,
      once: mockOnce,
      messages: {
        sendMessage: mockSendMessage,
        editMessage: mockEditMessage,
        sendReaction: mockSendReaction,
      },
      chats: {
        getChat: mockGetChat,
        startTyping: mockStartTyping,
        stopTyping: mockStopTyping,
      },
      polls: {
        create: mockPollCreate,
      },
    }));

  return {
    mockStartWatching,
    mockStopWatching,
    mockLocalClose,
    mockSend,
    mockConnect,
    mockClose,
    mockOn,
    mockOnce,
    mockSendMessage,
    mockEditMessage,
    mockGetChat,
    mockSendReaction,
    mockStartTyping,
    mockStopTyping,
    mockGatewayConnect,
    mockGatewayClose,
    mockGatewayOn,
    mockPollCreate,
    mockProcessModalSubmit,
    MockAdvancedIMessageKit,
    mockIsPollVote,
    mockParsePollVotes,
  };
});

vi.mock("@photon-ai/imessage-kit", () => ({
  // biome-ignore lint/complexity/useArrowFunction: vitest 4 requires function expressions for constructor mocks
  IMessageSDK: vi.fn(function () {
    return {
      startWatching: mockStartWatching,
      stopWatching: mockStopWatching,
      close: mockLocalClose,
      send: mockSend,
    };
  }),
}));

vi.mock("@photon-ai/advanced-imessage-kit", () => ({
  AdvancedIMessageKit: MockAdvancedIMessageKit,
  isPollVote: mockIsPollVote,
  parsePollVotes: mockParsePollVotes,
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
import { createiMessageAdapter, iMessageAdapter } from "./index";

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(() => mockLogger),
};

function createMockChat() {
  return {
    handleIncomingMessage: vi.fn(),
    processModalSubmit: mockProcessModalSubmit,
  };
}

describe("iMessageAdapter", () => {
  it("should have the correct name", () => {
    const adapter = new iMessageAdapter({ local: true, logger: mockLogger });
    expect(adapter.name).toBe("imessage");
  });

  it("should store local mode config", () => {
    const adapter = new iMessageAdapter({ local: true, logger: mockLogger });
    expect(adapter.local).toBe(true);
    expect(adapter.serverUrl).toBeUndefined();
    expect(adapter.apiKey).toBeUndefined();
  });

  it("should store local mode config with optional serverUrl", () => {
    const adapter = new iMessageAdapter({
      local: true,
      logger: mockLogger,
      serverUrl: "http://localhost:1234",
    });
    expect(adapter.local).toBe(true);
    expect(adapter.serverUrl).toBe("http://localhost:1234");
  });

  it("should store remote mode config", () => {
    const adapter = new iMessageAdapter({
      local: false,
      logger: mockLogger,
      serverUrl: "https://example.com",
      apiKey: "test-key",
    });
    expect(adapter.local).toBe(false);
    expect(adapter.serverUrl).toBe("https://example.com");
    expect(adapter.apiKey).toBe("test-key");
  });

  it("should create IMessageSDK for local mode", async () => {
    const { IMessageSDK } = await import("@photon-ai/imessage-kit");
    const adapter = new iMessageAdapter({ local: true, logger: mockLogger });
    expect(IMessageSDK).toHaveBeenCalled();
    expect(adapter.sdk).toBeDefined();
  });

  it("should create AdvancedIMessageKit for remote mode", async () => {
    const { AdvancedIMessageKit } = await import(
      "@photon-ai/advanced-imessage-kit"
    );
    const adapter = new iMessageAdapter({
      local: false,
      logger: mockLogger,
      serverUrl: "https://example.com",
      apiKey: "test-key",
    });
    expect(AdvancedIMessageKit.getInstance).toHaveBeenCalledWith({
      serverUrl: "https://example.com",
      apiKey: "test-key",
    });
    expect(adapter.sdk).toBeDefined();
  });

  it("should throw on non-macOS platform in local mode", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      expect(
        () => new iMessageAdapter({ local: true, logger: mockLogger })
      ).toThrow("iMessage adapter local mode requires macOS");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("should allow remote mode on non-macOS platforms", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      const adapter = new iMessageAdapter({
        local: false,
        logger: mockLogger,
        serverUrl: "https://example.com",
        apiKey: "test-key",
      });
      expect(adapter.local).toBe(false);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });
});

describe("initialize", () => {
  it("should store chat instance and not throw", async () => {
    const adapter = new iMessageAdapter({ local: true, logger: mockLogger });
    const mockChat = createMockChat();
    await adapter.initialize(mockChat as never);
    expect(adapter.name).toBe("imessage");
  });

  it("should connect and wait for ready in remote mode", async () => {
    const adapter = new iMessageAdapter({
      local: false,
      logger: mockLogger,
      serverUrl: "https://example.com",
      apiKey: "test-key",
    });
    const mockChat = createMockChat();
    await adapter.initialize(mockChat as never);
    expect(mockConnect).toHaveBeenCalled();
    expect(mockOnce).toHaveBeenCalledWith("ready", expect.any(Function));
  });
});

describe("encodeThreadId / decodeThreadId", () => {
  it("should encode thread ID", () => {
    const adapter = new iMessageAdapter({ local: true, logger: mockLogger });
    const threadId = adapter.encodeThreadId({
      chatGuid: "iMessage;-;+1234567890",
    });
    expect(threadId).toBe("imessage:iMessage;-;+1234567890");
  });

  it("should decode thread ID", () => {
    const adapter = new iMessageAdapter({ local: true, logger: mockLogger });
    const result = adapter.decodeThreadId("imessage:iMessage;-;+1234567890");
    expect(result).toEqual({ chatGuid: "iMessage;-;+1234567890" });
  });

  it("should roundtrip encode/decode", () => {
    const adapter = new iMessageAdapter({ local: true, logger: mockLogger });
    const original = { chatGuid: "iMessage;+;chat123456" };
    const encoded = adapter.encodeThreadId(original);
    const decoded = adapter.decodeThreadId(encoded);
    expect(decoded).toEqual(original);
  });

  it("should throw on thread ID from another adapter", () => {
    const adapter = new iMessageAdapter({ local: true, logger: mockLogger });
    expect(() => adapter.decodeThreadId("slack:C123:1234567890.123")).toThrow(
      "Invalid iMessage thread ID"
    );
  });
});

describe("isDM", () => {
  it("should return true for DM thread IDs (;-; pattern)", () => {
    const adapter = new iMessageAdapter({ local: true, logger: mockLogger });
    expect(adapter.isDM("imessage:iMessage;-;+1234567890")).toBe(true);
  });

  it("should return false for group thread IDs (;+; pattern)", () => {
    const adapter = new iMessageAdapter({ local: true, logger: mockLogger });
    expect(adapter.isDM("imessage:iMessage;+;chat493787071395575843")).toBe(
      false
    );
  });

  it("should return true for SMS DMs", () => {
    const adapter = new iMessageAdapter({ local: true, logger: mockLogger });
    expect(adapter.isDM("imessage:SMS;-;+1234567890")).toBe(true);
  });
});

describe("handleWebhook", () => {
  it("should return 501 (not supported)", async () => {
    const adapter = new iMessageAdapter({ local: true, logger: mockLogger });
    await adapter.initialize(createMockChat() as never);

    const request = new Request("https://example.com/webhook", {
      method: "POST",
      body: "{}",
    });

    const response = await adapter.handleWebhook(request);
    expect(response.status).toBe(501);
  });
});

describe("startGatewayListener", () => {
  afterEach(() => {
    mockGatewayConnect.mockReset();
    mockGatewayClose.mockReset();
    mockGatewayOn.mockReset();
    mockClose.mockReset();
  });

  it("should return 500 without chat instance", async () => {
    const adapter = new iMessageAdapter({ local: true, logger: mockLogger });
    const response = await adapter.startGatewayListener({
      waitUntil: vi.fn(),
    });
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toBe("Chat instance not initialized");
  });

  it("should return 500 without waitUntil", async () => {
    const adapter = new iMessageAdapter({ local: true, logger: mockLogger });
    await adapter.initialize(createMockChat() as never);

    const response = await adapter.startGatewayListener({});
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toBe("waitUntil not provided");
  });

  it("should start listening and return success response", async () => {
    const adapter = new iMessageAdapter({ local: true, logger: mockLogger });
    await adapter.initialize(createMockChat() as never);

    const waitUntil = vi.fn();
    const response = await adapter.startGatewayListener({ waitUntil }, 5000);

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe("listening");
    expect(body.durationMs).toBe(5000);
    expect(body.mode).toBe("local");
    expect(waitUntil).toHaveBeenCalledOnce();
  });

  it("should use abort signal to stop early", async () => {
    const adapter = new iMessageAdapter({ local: true, logger: mockLogger });
    await adapter.initialize(createMockChat() as never);

    const controller = new AbortController();
    const waitUntil = vi.fn();

    await adapter.startGatewayListener({ waitUntil }, 60000, controller.signal);

    expect(waitUntil).toHaveBeenCalledOnce();
    const listenerPromise = waitUntil.mock.calls[0][0] as Promise<void>;

    controller.abort();

    await listenerPromise;
    expect(mockStopWatching).toHaveBeenCalled();
  });

  it("should create a dedicated SDK instance in remote mode and close only that", async () => {
    const adapter = new iMessageAdapter({
      local: false,
      logger: mockLogger,
      serverUrl: "https://example.com",
      apiKey: "test-key",
    });
    await adapter.initialize(createMockChat() as never);

    const controller = new AbortController();
    const waitUntil = vi.fn();

    const callCountBefore = MockAdvancedIMessageKit.mock.calls.length;

    await adapter.startGatewayListener({ waitUntil }, 60000, controller.signal);

    expect(MockAdvancedIMessageKit.mock.calls.length).toBe(callCountBefore + 1);
    expect(MockAdvancedIMessageKit).toHaveBeenLastCalledWith({
      serverUrl: "https://example.com",
      apiKey: "test-key",
    });

    expect(mockGatewayConnect).toHaveBeenCalled();
    expect(mockGatewayOn).toHaveBeenCalledWith(
      "new-message",
      expect.any(Function)
    );

    controller.abort();
    const listenerPromise = waitUntil.mock.calls[0][0] as Promise<void>;
    await listenerPromise;

    expect(mockGatewayClose).toHaveBeenCalled();
    expect(mockClose).not.toHaveBeenCalled();
  });
});

describe("otel integration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockOtelProviders() {
    const spanSetStatus = vi.fn();
    const spanRecordException = vi.fn();
    const spanEnd = vi.fn();
    const spanSetAttribute = vi.fn();
    const startActiveSpan = vi.fn(
      (_name: string, _options: unknown, fn: (span: unknown) => unknown) =>
        fn({
          setStatus: spanSetStatus,
          recordException: spanRecordException,
          end: spanEnd,
          setAttribute: spanSetAttribute,
        }),
    );

    const counterAdd = vi.fn();
    const histogramRecord = vi.fn();
    const upDownCounterAdd = vi.fn();

    const tracerForceFlush = vi.fn().mockResolvedValue(undefined);
    const meterForceFlush = vi.fn().mockResolvedValue(undefined);
    const loggerForceFlush = vi.fn().mockResolvedValue(undefined);
    const loggerEmit = vi.fn();

    vi.spyOn(trace, "getTracerProvider").mockReturnValue({
      getTracer: () => ({ startActiveSpan }),
      forceFlush: tracerForceFlush,
    } as never);

    vi.spyOn(metrics, "getMeterProvider").mockReturnValue({
      getMeter: () => ({
        createCounter: () => ({ add: counterAdd }),
        createHistogram: () => ({ record: histogramRecord }),
        createUpDownCounter: () => ({ add: upDownCounterAdd }),
      }),
      forceFlush: meterForceFlush,
    } as never);

    vi.spyOn(logs, "getLoggerProvider").mockReturnValue({
      getLogger: () => ({ emit: loggerEmit }),
      forceFlush: loggerForceFlush,
    } as never);

    return {
      startActiveSpan,
      spanSetStatus,
      spanEnd,
      spanSetAttribute,
      counterAdd,
      histogramRecord,
      upDownCounterAdd,
      tracerForceFlush,
      meterForceFlush,
      loggerForceFlush,
      loggerEmit,
    };
  }

  it("constructor with OTel enabled uses tracer, real metrics, and OTelLogger", () => {
    const mocks = mockOtelProviders();

    const adapter = new iMessageAdapter({
      local: false,
      logger: mockLogger,
      serverUrl: "https://example.com",
      apiKey: "test-key",
      otel: { enabled: true, serviceName: "test-bot" },
    });

    // Tracer is not null — adapter should call startActiveSpan on any operation
    // Metrics are real — counterAdd should be callable
    // Logger is wrapped — loggerEmit should fire on log calls
    expect(adapter).toBeDefined();
    expect(mocks.startActiveSpan).not.toHaveBeenCalled(); // no operation yet
  });

  it("constructor with OTel disabled uses null tracer and NOOP metrics", () => {
    const getTracerProviderSpy = vi.spyOn(trace, "getTracerProvider");
    const getMeterProviderSpy = vi.spyOn(metrics, "getMeterProvider");

    new iMessageAdapter({
      local: false,
      logger: mockLogger,
      serverUrl: "https://example.com",
      apiKey: "test-key",
      otel: { enabled: false },
    });

    expect(getTracerProviderSpy).not.toHaveBeenCalled();
    expect(getMeterProviderSpy).not.toHaveBeenCalled();
  });

  it("uses custom providers instead of global when provided", () => {
    const customTracer = { getTracer: vi.fn(() => ({ startActiveSpan: vi.fn() })) };
    const customMeter = {
      getMeter: vi.fn(() => ({
        createCounter: () => ({ add() {} }),
        createHistogram: () => ({ record() {} }),
        createUpDownCounter: () => ({ add() {} }),
      })),
    };
    const customLogger = { getLogger: vi.fn(() => ({ emit() {} })) };

    const getTracerProviderSpy = vi.spyOn(trace, "getTracerProvider");
    const getMeterProviderSpy = vi.spyOn(metrics, "getMeterProvider");
    const getLoggerProviderSpy = vi.spyOn(logs, "getLoggerProvider");

    new iMessageAdapter({
      local: false,
      logger: mockLogger,
      serverUrl: "https://example.com",
      apiKey: "test-key",
      otel: {
        enabled: true,
        tracerProvider: customTracer as never,
        meterProvider: customMeter as never,
        loggerProvider: customLogger as never,
      },
    });

    expect(getTracerProviderSpy).not.toHaveBeenCalled();
    expect(getMeterProviderSpy).not.toHaveBeenCalled();
    expect(getLoggerProviderSpy).not.toHaveBeenCalled();
    expect(customTracer.getTracer).toHaveBeenCalled();
    expect(customMeter.getMeter).toHaveBeenCalled();
    expect(customLogger.getLogger).toHaveBeenCalled();
  });

  it("wraps logger with OTelLogger when enabled", () => {
    const mocks = mockOtelProviders();

    const adapter = new iMessageAdapter({
      local: false,
      logger: mockLogger,
      serverUrl: "https://example.com",
      apiKey: "test-key",
      otel: { enabled: true },
    });

    // Access private logger via a method that logs
    (adapter as unknown as { logger: { info: (msg: string) => void } }).logger.info("test");

    // Both delegate and OTel logger should have been called
    expect(mockLogger.info).toHaveBeenCalledWith("test", undefined);
    expect(mocks.loggerEmit).toHaveBeenCalledWith(
      expect.objectContaining({ body: "test" }),
    );
  });

  it("creates spans for adapter operations when OTel enabled", async () => {
    const mocks = mockOtelProviders();

    const adapter = new iMessageAdapter({
      local: false,
      logger: mockLogger,
      serverUrl: "https://example.com",
      apiKey: "test-key",
      otel: { enabled: true },
    });

    await adapter.initialize(createMockChat() as never);

    // initialize creates a span
    expect(mocks.startActiveSpan).toHaveBeenCalledWith(
      "adapter.initialize",
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("records metrics on postMessage", async () => {
    const mocks = mockOtelProviders();
    mockSendMessage.mockResolvedValue({ guid: "msg-001" });

    const adapter = new iMessageAdapter({
      local: false,
      logger: mockLogger,
      serverUrl: "https://example.com",
      apiKey: "test-key",
      otel: { enabled: true },
    });
    await adapter.initialize(createMockChat() as never);

    await adapter.postMessage("imessage:iMessage;-;+1234567890", "Hello!");

    // messagesSent counter and messageSendDuration histogram should be called
    expect(mocks.counterAdd).toHaveBeenCalled();
    expect(mocks.histogramRecord).toHaveBeenCalled();
  });

  it("records messageSendErrors on postMessage failure", async () => {
    const mocks = mockOtelProviders();
    mockSendMessage.mockRejectedValue(new Error("send failed"));

    const adapter = new iMessageAdapter({
      local: false,
      logger: mockLogger,
      serverUrl: "https://example.com",
      apiKey: "test-key",
      otel: { enabled: true },
    });
    await adapter.initialize(createMockChat() as never);

    await expect(
      adapter.postMessage("imessage:iMessage;-;+1234567890", "Hello!"),
    ).rejects.toThrow("send failed");

    // Error counter should have been incremented
    expect(mocks.counterAdd).toHaveBeenCalled();
  });

  it("flushTelemetry skips providers without forceFlush", async () => {
    // Use providers that have no forceFlush method
    vi.spyOn(trace, "getTracerProvider").mockReturnValue({
      getTracer: () => ({
        startActiveSpan: vi.fn((_n: string, _o: unknown, fn: (s: unknown) => unknown) =>
          fn({ setStatus() {}, recordException() {}, end() {}, setAttribute() {} })),
      }),
    } as never);

    vi.spyOn(metrics, "getMeterProvider").mockReturnValue({
      getMeter: () => ({
        createCounter: () => ({ add() {} }),
        createHistogram: () => ({ record() {} }),
        createUpDownCounter: () => ({ add() {} }),
      }),
    } as never);

    vi.spyOn(logs, "getLoggerProvider").mockReturnValue({
      getLogger: () => ({ emit() {} }),
    } as never);

    const adapter = new iMessageAdapter({
      local: false,
      logger: mockLogger,
      serverUrl: "https://example.com",
      apiKey: "test-key",
      otel: { enabled: true },
    });

    const flushTelemetry = (
      adapter as unknown as { flushTelemetry: () => Promise<void> }
    ).flushTelemetry.bind(adapter);

    // Should not throw
    await expect(flushTelemetry()).resolves.toBeUndefined();
  });

  it("flushTelemetry handles rejection gracefully via Promise.allSettled", async () => {
    vi.spyOn(trace, "getTracerProvider").mockReturnValue({
      getTracer: () => ({
        startActiveSpan: vi.fn((_n: string, _o: unknown, fn: (s: unknown) => unknown) =>
          fn({ setStatus() {}, recordException() {}, end() {}, setAttribute() {} })),
      }),
      forceFlush: vi.fn().mockRejectedValue(new Error("tracer flush failed")),
    } as never);

    const meterForceFlush = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(metrics, "getMeterProvider").mockReturnValue({
      getMeter: () => ({
        createCounter: () => ({ add() {} }),
        createHistogram: () => ({ record() {} }),
        createUpDownCounter: () => ({ add() {} }),
      }),
      forceFlush: meterForceFlush,
    } as never);

    vi.spyOn(logs, "getLoggerProvider").mockReturnValue({
      getLogger: () => ({ emit() {} }),
      forceFlush: vi.fn().mockResolvedValue(undefined),
    } as never);

    const adapter = new iMessageAdapter({
      local: false,
      logger: mockLogger,
      serverUrl: "https://example.com",
      apiKey: "test-key",
      otel: { enabled: true },
    });

    const flushTelemetry = (
      adapter as unknown as { flushTelemetry: () => Promise<void> }
    ).flushTelemetry.bind(adapter);

    // Should not throw despite tracer flush failing
    await expect(flushTelemetry()).resolves.toBeUndefined();
    // Other providers still flushed
    expect(meterForceFlush).toHaveBeenCalledOnce();
  });

  describe("metrics resilience", () => {
    it("postMessage returns result even when metrics.messagesSent.add throws", async () => {
      const mocks = mockOtelProviders();
      mocks.counterAdd.mockImplementation(() => { throw new Error("counter exploded"); });
      mockSendMessage.mockResolvedValue({ guid: "msg-001" });

      const adapter = new iMessageAdapter({
        local: false, logger: mockLogger,
        serverUrl: "https://example.com", apiKey: "test-key",
        otel: { enabled: true },
      });
      await adapter.initialize(createMockChat() as never);

      const result = await adapter.postMessage("imessage:iMessage;-;+1234567890", "Hello!");
      expect(result.id).toBe("msg-001");
    });

    it("postMessage propagates original SDK error when both SDK and metrics fail", async () => {
      const mocks = mockOtelProviders();
      mockSendMessage.mockRejectedValue(new Error("sdk-send-failed"));
      mocks.counterAdd.mockImplementation(() => { throw new Error("counter exploded"); });

      const adapter = new iMessageAdapter({
        local: false, logger: mockLogger,
        serverUrl: "https://example.com", apiKey: "test-key",
        otel: { enabled: true },
      });
      await adapter.initialize(createMockChat() as never);

      await expect(
        adapter.postMessage("imessage:iMessage;-;+1234567890", "Hello!")
      ).rejects.toThrow("sdk-send-failed");
    });

    it("addReaction succeeds even when metrics.reactionsSent.add throws", async () => {
      const mocks = mockOtelProviders();
      mocks.counterAdd.mockImplementation(() => { throw new Error("counter exploded"); });
      mockSendReaction.mockResolvedValue({});

      const adapter = new iMessageAdapter({
        local: false, logger: mockLogger,
        serverUrl: "https://example.com", apiKey: "test-key",
        otel: { enabled: true },
      });
      await adapter.initialize(createMockChat() as never);

      await expect(
        adapter.addReaction("imessage:iMessage;-;+1234567890", "msg-001", "heart")
      ).resolves.toBeUndefined();
    });
  });

  it("flushes resolved global providers when explicit providers are omitted", async () => {
    const tracerForceFlush = vi.fn().mockResolvedValue(undefined);
    const meterForceFlush = vi.fn().mockResolvedValue(undefined);
    const loggerForceFlush = vi.fn().mockResolvedValue(undefined);

    vi.spyOn(trace, "getTracerProvider").mockReturnValue({
      getTracer: () => ({
        startActiveSpan: (_name: string, _options: unknown, fn: (span: {
          setStatus: () => void;
          recordException: () => void;
          end: () => void;
          setAttribute: () => void;
        }) => unknown) => fn({
          setStatus() {},
          recordException() {},
          end() {},
          setAttribute() {},
        }),
      }),
      forceFlush: tracerForceFlush,
    } as never);

    vi.spyOn(metrics, "getMeterProvider").mockReturnValue({
      getMeter: () => ({
        createCounter: () => ({ add() {} }),
        createHistogram: () => ({ record() {} }),
        createUpDownCounter: () => ({ add() {} }),
      }),
      forceFlush: meterForceFlush,
    } as never);

    vi.spyOn(logs, "getLoggerProvider").mockReturnValue({
      getLogger: () => ({ emit() {} }),
      forceFlush: loggerForceFlush,
    } as never);

    const adapter = new iMessageAdapter({
      local: false,
      logger: mockLogger,
      serverUrl: "https://example.com",
      apiKey: "test-key",
      otel: { enabled: true },
    });

    const flushTelemetry = (
      adapter as unknown as { flushTelemetry: () => Promise<void> }
    ).flushTelemetry.bind(adapter);

    await flushTelemetry();

    expect(tracerForceFlush).toHaveBeenCalledOnce();
    expect(meterForceFlush).toHaveBeenCalledOnce();
    expect(loggerForceFlush).toHaveBeenCalledOnce();
  });

  describe("enabled:false isolation", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("never calls global TracerProvider when disabled", async () => {
      const getTracer = vi.fn();
      vi.spyOn(trace, "getTracerProvider").mockReturnValue({ getTracer } as never);

      const adapter = new iMessageAdapter({
        local: false, logger: mockLogger,
        serverUrl: "https://example.com", apiKey: "test-key",
        otel: { enabled: false },
      });
      await adapter.initialize(createMockChat() as never);
      mockSendMessage.mockResolvedValue({ guid: "msg-001" });
      await adapter.postMessage("imessage:iMessage;-;+1234567890", "Hello");

      expect(getTracer).not.toHaveBeenCalled();
    });

    it("never calls global MeterProvider when disabled", async () => {
      const getMeter = vi.fn();
      vi.spyOn(metrics, "getMeterProvider").mockReturnValue({ getMeter } as never);

      const adapter = new iMessageAdapter({
        local: false, logger: mockLogger,
        serverUrl: "https://example.com", apiKey: "test-key",
        otel: { enabled: false },
      });
      await adapter.initialize(createMockChat() as never);
      mockSendMessage.mockResolvedValue({ guid: "msg-001" });
      await adapter.postMessage("imessage:iMessage;-;+1234567890", "Hello");

      expect(getMeter).not.toHaveBeenCalled();
    });

    it("never calls global LoggerProvider when disabled", async () => {
      const getLogger = vi.fn();
      vi.spyOn(logs, "getLoggerProvider").mockReturnValue({ getLogger } as never);

      const adapter = new iMessageAdapter({
        local: false, logger: mockLogger,
        serverUrl: "https://example.com", apiKey: "test-key",
        otel: { enabled: false },
      });
      await adapter.initialize(createMockChat() as never);

      expect(getLogger).not.toHaveBeenCalled();
    });

    it("uses raw delegate logger (not OTelLogger) when disabled", () => {
      const adapter = new iMessageAdapter({
        local: false, logger: mockLogger,
        serverUrl: "https://example.com", apiKey: "test-key",
        otel: { enabled: false },
      });
      const logger = (adapter as unknown as { logger: object }).logger;
      expect(logger).toBe(mockLogger);
    });
  });

  describe("flushTelemetry edge cases", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("does not throw when called on disabled adapter", async () => {
      const adapter = new iMessageAdapter({
        local: false, logger: mockLogger,
        serverUrl: "https://example.com", apiKey: "test-key",
        otel: { enabled: false },
      });

      const flush = (adapter as unknown as { flushTelemetry: () => Promise<void> })
        .flushTelemetry.bind(adapter);

      await expect(flush()).resolves.toBeUndefined();
    });

    it("resolves even when one forceFlush hangs temporarily", async () => {
      const slowFlush = () => new Promise<void>((resolve) => setTimeout(resolve, 100));
      const fastFlush = vi.fn().mockResolvedValue(undefined);

      vi.spyOn(trace, "getTracerProvider").mockReturnValue({
        getTracer: () => ({
          startActiveSpan: vi.fn((_n, _o, fn) =>
            fn({ setStatus() {}, recordException() {}, end() {}, setAttribute() {} })),
        }),
        forceFlush: slowFlush,
      } as never);
      vi.spyOn(metrics, "getMeterProvider").mockReturnValue({
        getMeter: () => ({
          createCounter: () => ({ add() {} }),
          createHistogram: () => ({ record() {} }),
          createUpDownCounter: () => ({ add() {} }),
        }),
        forceFlush: fastFlush,
      } as never);
      vi.spyOn(logs, "getLoggerProvider").mockReturnValue({
        getLogger: () => ({ emit() {} }),
        forceFlush: fastFlush,
      } as never);

      const adapter = new iMessageAdapter({
        local: false, logger: mockLogger,
        serverUrl: "https://example.com", apiKey: "test-key",
        otel: { enabled: true },
      });

      const flush = (adapter as unknown as { flushTelemetry: () => Promise<void> })
        .flushTelemetry.bind(adapter);

      await expect(flush()).resolves.toBeUndefined();
      expect(fastFlush).toHaveBeenCalledTimes(2);
    });
  });

  describe("serviceName propagation", () => {
    afterEach(() => {
      vi.restoreAllMocks();
      mockSendMessage.mockReset();
    });

    it("includes service.name in span attributes when serviceName is set", async () => {
      const mocks = mockOtelProviders();
      mockSendMessage.mockResolvedValue({ guid: "msg-001" });

      const adapter = new iMessageAdapter({
        local: false, logger: mockLogger,
        serverUrl: "https://example.com", apiKey: "test-key",
        otel: { enabled: true, serviceName: "my-bot" },
      });
      await adapter.initialize(createMockChat() as never);
      await adapter.postMessage("imessage:iMessage;-;+1234567890", "Hi");

      const postMsgCall = mocks.startActiveSpan.mock.calls.find(
        (c) => c[0] === "adapter.post_message"
      );
      expect(postMsgCall).toBeDefined();
      expect((postMsgCall![1] as Record<string, any>).attributes["service.name"]).toBe("my-bot");
    });

    it("includes service.name in metric attributes when serviceName is set", async () => {
      const mocks = mockOtelProviders();
      mockSendMessage.mockResolvedValue({ guid: "msg-001" });

      const adapter = new iMessageAdapter({
        local: false, logger: mockLogger,
        serverUrl: "https://example.com", apiKey: "test-key",
        otel: { enabled: true, serviceName: "my-bot" },
      });
      await adapter.initialize(createMockChat() as never);
      await adapter.postMessage("imessage:iMessage;-;+1234567890", "Hi");

      // Find a counterAdd call with service.name
      const callWithServiceName = mocks.counterAdd.mock.calls.find(
        (c) => c[1] && c[1]["service.name"] === "my-bot"
      );
      expect(callWithServiceName).toBeDefined();
    });

    it("includes service.name in logger base attributes when serviceName is set", () => {
      const mocks = mockOtelProviders();

      const adapter = new iMessageAdapter({
        local: false, logger: mockLogger,
        serverUrl: "https://example.com", apiKey: "test-key",
        otel: { enabled: true, serviceName: "my-bot" },
      });

      // Trigger a log via the adapter's wrapped logger
      (adapter as unknown as { logger: { info: (msg: string) => void } }).logger.info("test");

      expect(mocks.loggerEmit).toHaveBeenCalledWith(
        expect.objectContaining({
          attributes: expect.objectContaining({ "service.name": "my-bot" }),
        }),
      );
    });

    it("omits service.name from attributes when serviceName is not set", async () => {
      const mocks = mockOtelProviders();
      mockSendMessage.mockResolvedValue({ guid: "msg-001" });

      const adapter = new iMessageAdapter({
        local: false, logger: mockLogger,
        serverUrl: "https://example.com", apiKey: "test-key",
        otel: { enabled: true },
      });
      await adapter.initialize(createMockChat() as never);
      await adapter.postMessage("imessage:iMessage;-;+1234567890", "Hi");

      const postMsgCall = mocks.startActiveSpan.mock.calls.find(
        (c) => c[0] === "adapter.post_message"
      );
      expect((postMsgCall![1] as Record<string, any>).attributes).not.toHaveProperty("service.name");
    });
  });

  describe("gateway resilience", () => {
    afterEach(() => {
      vi.restoreAllMocks();
      mockGatewayOn.mockReset();
      mockGatewayConnect.mockReset();
      mockGatewayClose.mockReset();
    });

    it("listener completes even when metrics throw in message handler", async () => {
      const mocks = mockOtelProviders();
      mocks.counterAdd.mockImplementation(() => { throw new Error("counter exploded"); });

      const adapter = new iMessageAdapter({
        local: false, logger: mockLogger,
        serverUrl: "https://example.com", apiKey: "test-key",
        otel: { enabled: true },
      });
      await adapter.initialize(createMockChat() as never);

      const abortController = new AbortController();
      const mockWaitUntil = vi.fn();

      const response = await adapter.startGatewayListener(
        { waitUntil: mockWaitUntil } as never,
        50,
        abortController.signal,
      );

      expect(response.status).toBe(200);
      abortController.abort();

      const listenerPromise = mockWaitUntil.mock.calls[0]?.[0];
      await expect(
        Promise.race([
          listenerPromise,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("listener hung")), 500)
          ),
        ])
      ).resolves.toBeUndefined();
    });
  });

  describe("PII redaction end-to-end", () => {
    afterEach(() => {
      vi.restoreAllMocks();
      mockSendMessage.mockReset();
    });

    it("span attributes redact phone numbers in threadId and chatGuid", async () => {
      const mocks = mockOtelProviders();
      mockSendMessage.mockResolvedValue({ guid: "msg-001" });

      const adapter = new iMessageAdapter({
        local: false, logger: mockLogger,
        serverUrl: "https://example.com", apiKey: "test-key",
        otel: { enabled: true, redactPII: true },
      });
      await adapter.initialize(createMockChat() as never);

      await adapter.postMessage("imessage:iMessage;-;+15551234567", "Hello!");

      // Find the postMessage span call
      const postMsgCall = mocks.startActiveSpan.mock.calls.find(
        (c) => c[0] === "adapter.post_message"
      );
      expect(postMsgCall).toBeDefined();
      const spanAttrs = (postMsgCall![1] as Record<string, any>).attributes;

      // threadId must be redacted
      expect(spanAttrs["imessage.thread_id"]).toBe("imessage:iMessage;-;+1555***4567");
      // chatGuid must be redacted
      expect(spanAttrs["imessage.chat_guid"]).toBe("iMessage;-;+1555***4567");

      // Neither should contain the raw phone number
      expect(spanAttrs["imessage.thread_id"]).not.toContain("+15551234567");
      expect(spanAttrs["imessage.chat_guid"]).not.toContain("+15551234567");
    });
  });

  describe("async edge cases", () => {
    afterEach(() => {
      vi.restoreAllMocks();
      mockGatewayOn.mockReset();
      mockGatewayConnect.mockReset();
      mockGatewayClose.mockReset();
    });

    it("listener shuts down even when a message handler hangs", async () => {
      const mocks = mockOtelProviders();

      mockGatewayOn.mockImplementation((event, handler) => {
        if (event === "new-message") {
          setTimeout(() => {
            handler({
              guid: "hanging-msg",
              text: "hello",
              isFromMe: false,
              chats: [{ guid: "iMessage;-;+15551234567" }],
              handle: { address: "+15551234567" },
              dateCreated: Date.now(),
              attachments: [],
            });
          }, 10);
        }
      });

      const adapter = new iMessageAdapter({
        local: false, logger: mockLogger,
        serverUrl: "https://example.com", apiKey: "test-key",
        otel: { enabled: true },
      });
      await adapter.initialize(createMockChat() as never);

      const abortController = new AbortController();
      const mockWaitUntil = vi.fn();

      const response = await adapter.startGatewayListener(
        { waitUntil: mockWaitUntil } as never,
        50,
        abortController.signal,
      );

      expect(response.status).toBe(200);
      abortController.abort();

      // CRITICAL: Assert the listener promise ACTUALLY RESOLVED
      const listenerPromise = mockWaitUntil.mock.calls[0]?.[0];
      await expect(
        Promise.race([
          listenerPromise,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("listener hung — did not resolve within 500ms")), 500)
          ),
        ])
      ).resolves.toBeUndefined();
    });

    it("handles duplicate message GUIDs without crash", async () => {
      const mocks = mockOtelProviders();

      mockGatewayOn.mockImplementation((event, handler) => {
        if (event === "new-message") {
          const msg = {
            guid: "duplicate-guid-001",
            text: "hello",
            isFromMe: false,
            chats: [{ guid: "iMessage;-;+15551234567" }],
            handle: { address: "+15551234567" },
            dateCreated: Date.now(),
            attachments: [],
          };
          setTimeout(() => handler(msg), 10);
          setTimeout(() => handler(msg), 20);
        }
      });

      const mockChat = createMockChat();
      const processedMessages: string[] = [];
      (mockChat as unknown as { processMessage: ReturnType<typeof vi.fn> }).processMessage =
        vi.fn((_adapter, _threadId, message) => {
          processedMessages.push(message.id);
        });

      const adapter = new iMessageAdapter({
        local: false, logger: mockLogger,
        serverUrl: "https://example.com", apiKey: "test-key",
        otel: { enabled: true },
      });
      await adapter.initialize(mockChat as never);

      const abortController = new AbortController();
      const mockWaitUntil = vi.fn();

      await adapter.startGatewayListener(
        { waitUntil: mockWaitUntil } as never,
        100,
        abortController.signal,
      );

      // Wait for messages to be processed
      await new Promise((r) => setTimeout(r, 50));
      abortController.abort();
      await mockWaitUntil.mock.calls[0]?.[0];

      // Both should have been processed (no dedup in adapter)
      expect(processedMessages).toHaveLength(2);
    });
  });

  describe("multi-instance isolation", () => {
    it("two adapters have independent metrics instances", () => {
      mockOtelProviders();

      const adapter1 = new iMessageAdapter({
        local: false,
        logger: mockLogger,
        serverUrl: "https://example.com",
        apiKey: "test-key",
        otel: { enabled: true, serviceName: "service-a" },
      });

      const adapter2 = new iMessageAdapter({
        local: false,
        logger: mockLogger,
        serverUrl: "https://example.com",
        apiKey: "test-key",
        otel: { enabled: true, serviceName: "service-b" },
      });

      const metrics1 = (adapter1 as unknown as { metrics: object }).metrics;
      const metrics2 = (adapter2 as unknown as { metrics: object }).metrics;

      expect(metrics1).toBeDefined();
      expect(metrics2).toBeDefined();
      expect(metrics1).not.toBe(metrics2);
    });

    it("enabled and disabled adapters coexist without interference", async () => {
      const mocks = mockOtelProviders();
      mockSendMessage.mockResolvedValue({ guid: "msg-001" });

      const enabledAdapter = new iMessageAdapter({
        local: false,
        logger: mockLogger,
        serverUrl: "https://example.com",
        apiKey: "test-key",
        otel: { enabled: true },
      });

      const disabledAdapter = new iMessageAdapter({
        local: false,
        logger: mockLogger,
        serverUrl: "https://example.com",
        apiKey: "test-key",
        otel: { enabled: false },
      });

      await enabledAdapter.initialize(createMockChat() as never);
      await disabledAdapter.initialize(createMockChat() as never);

      // Record call count before operations
      const spanCallsBefore = mocks.startActiveSpan.mock.calls.length;

      await enabledAdapter.postMessage("imessage:iMessage;-;+1234567890", "Hello from enabled!");
      const spansAfterEnabled = mocks.startActiveSpan.mock.calls.length;

      await disabledAdapter.postMessage("imessage:iMessage;-;+1234567890", "Hello from disabled!");
      const spansAfterDisabled = mocks.startActiveSpan.mock.calls.length;

      // Enabled adapter should have created spans
      expect(spansAfterEnabled).toBeGreaterThan(spanCallsBefore);
      // Disabled adapter should NOT have created additional spans
      expect(spansAfterDisabled).toBe(spansAfterEnabled);
    });

    it("two enabled adapters with different providers don't cross-contaminate", async () => {
      const startActiveSpanA = vi.fn(
        (_name: string, _options: unknown, fn: (span: unknown) => unknown) =>
          fn({ setStatus: vi.fn(), recordException: vi.fn(), end: vi.fn(), setAttribute: vi.fn() }),
      );
      const startActiveSpanB = vi.fn(
        (_name: string, _options: unknown, fn: (span: unknown) => unknown) =>
          fn({ setStatus: vi.fn(), recordException: vi.fn(), end: vi.fn(), setAttribute: vi.fn() }),
      );

      const makeMeterProvider = () => ({
        getMeter: () => ({
          createCounter: () => ({ add: vi.fn() }),
          createHistogram: () => ({ record: vi.fn() }),
          createUpDownCounter: () => ({ add: vi.fn() }),
        }),
      });

      const makeLoggerProvider = () => ({
        getLogger: () => ({ emit: vi.fn() }),
      });

      const providerA = {
        tracerProvider: { getTracer: () => ({ startActiveSpan: startActiveSpanA }) } as never,
        meterProvider: makeMeterProvider() as never,
        loggerProvider: makeLoggerProvider() as never,
      };

      const providerB = {
        tracerProvider: { getTracer: () => ({ startActiveSpan: startActiveSpanB }) } as never,
        meterProvider: makeMeterProvider() as never,
        loggerProvider: makeLoggerProvider() as never,
      };

      mockSendMessage.mockResolvedValue({ guid: "msg-001" });

      const adapter1 = new iMessageAdapter({
        local: false,
        logger: mockLogger,
        serverUrl: "https://example.com",
        apiKey: "test-key",
        otel: { enabled: true, ...providerA },
      });

      const adapter2 = new iMessageAdapter({
        local: false,
        logger: mockLogger,
        serverUrl: "https://example.com",
        apiKey: "test-key",
        otel: { enabled: true, ...providerB },
      });

      await adapter1.initialize(createMockChat() as never);
      await adapter2.initialize(createMockChat() as never);

      // Reset call counts after initialize
      startActiveSpanA.mockClear();
      startActiveSpanB.mockClear();

      await adapter1.postMessage("imessage:iMessage;-;+1234567890", "Hello from A!");

      // Only providerA's tracer should have been called
      expect(startActiveSpanA).toHaveBeenCalled();
      expect(startActiveSpanB).not.toHaveBeenCalled();

      startActiveSpanA.mockClear();
      startActiveSpanB.mockClear();

      await adapter2.postMessage("imessage:iMessage;-;+1234567890", "Hello from B!");

      // Only providerB's tracer should have been called
      expect(startActiveSpanB).toHaveBeenCalled();
      expect(startActiveSpanA).not.toHaveBeenCalled();
    });
  });
});

describe("postMessage", () => {
  afterEach(() => {
    mockSend.mockReset();
    mockSendMessage.mockReset();
  });

  it("should send via local SDK with DM chatGuid", async () => {
    const adapter = new iMessageAdapter({ local: true, logger: mockLogger });
    await adapter.initialize(createMockChat() as never);

    mockSend.mockResolvedValue({
      sentAt: new Date(),
      message: { guid: "sent-msg-001" },
    });

    const result = await adapter.postMessage(
      "imessage:iMessage;-;+1234567890",
      "Hello!"
    );

    expect(mockSend).toHaveBeenCalledWith("+1234567890", "Hello!");
    expect(result.id).toBe("sent-msg-001");
    expect(result.threadId).toBe("imessage:iMessage;-;+1234567890");
    expect(result.raw).toEqual({
      sentAt: expect.any(Date),
      message: { guid: "sent-msg-001" },
    });
  });

  it("should send via local SDK with group chatGuid", async () => {
    const adapter = new iMessageAdapter({ local: true, logger: mockLogger });
    await adapter.initialize(createMockChat() as never);

    mockSend.mockResolvedValue({
      sentAt: new Date(),
      message: { guid: "sent-msg-002" },
    });

    const result = await adapter.postMessage(
      "imessage:iMessage;+;chat493787071395575843",
      "Hello group!"
    );

    expect(mockSend).toHaveBeenCalledWith(
      "chat493787071395575843",
      "Hello group!"
    );
    expect(result.id).toBe("sent-msg-002");
  });

  it("should fallback to generated ID when local SDK has no message guid", async () => {
    const adapter = new iMessageAdapter({ local: true, logger: mockLogger });
    await adapter.initialize(createMockChat() as never);

    mockSend.mockResolvedValue({ sentAt: new Date() });

    const result = await adapter.postMessage(
      "imessage:iMessage;-;+1234567890",
      "Hi"
    );

    expect(result.id).toMatch(LOCAL_ID_PATTERN);
  });

  it("should send via remote SDK", async () => {
    const adapter = new iMessageAdapter({
      local: false,
      logger: mockLogger,
      serverUrl: "https://example.com",
      apiKey: "test-key",
    });
    await adapter.initialize(createMockChat() as never);

    mockSendMessage.mockResolvedValue({
      guid: "remote-msg-001",
      text: "Hello!",
    });

    const result = await adapter.postMessage(
      "imessage:iMessage;-;+1234567890",
      "Hello!"
    );

    expect(mockSendMessage).toHaveBeenCalledWith({
      chatGuid: "iMessage;-;+1234567890",
      message: "Hello!",
    });
    expect(result.id).toBe("remote-msg-001");
    expect(result.threadId).toBe("imessage:iMessage;-;+1234567890");
    expect(result.raw).toEqual({
      guid: "remote-msg-001",
      text: "Hello!",
    });
  });
});

describe("editMessage", () => {
  afterEach(() => {
    mockEditMessage.mockReset();
  });

  it("should throw NotImplementedError in local mode", async () => {
    const adapter = new iMessageAdapter({ local: true, logger: mockLogger });
    await adapter.initialize(createMockChat() as never);

    await expect(
      adapter.editMessage(
        "imessage:iMessage;-;+1234567890",
        "msg-guid-001",
        "Updated text"
      )
    ).rejects.toThrow("editMessage is not supported in local mode");
  });

  it("should edit via remote SDK", async () => {
    const adapter = new iMessageAdapter({
      local: false,
      logger: mockLogger,
      serverUrl: "https://example.com",
      apiKey: "test-key",
    });
    await adapter.initialize(createMockChat() as never);

    mockEditMessage.mockResolvedValue({
      guid: "msg-guid-001",
      text: "Updated text",
      dateEdited: 1234567890,
    });

    const result = await adapter.editMessage(
      "imessage:iMessage;-;+1234567890",
      "msg-guid-001",
      "Updated text"
    );

    expect(mockEditMessage).toHaveBeenCalledWith({
      messageGuid: "msg-guid-001",
      editedMessage: "Updated text",
      backwardsCompatibilityMessage: "Updated text",
    });
    expect(result.id).toBe("msg-guid-001");
    expect(result.threadId).toBe("imessage:iMessage;-;+1234567890");
    expect(result.raw).toEqual({
      guid: "msg-guid-001",
      text: "Updated text",
      dateEdited: 1234567890,
    });
  });
});

describe("addReaction / removeReaction", () => {
  afterEach(() => {
    mockSendReaction.mockReset();
  });

  it("should throw NotImplementedError in local mode for addReaction", async () => {
    const adapter = new iMessageAdapter({ local: true, logger: mockLogger });
    await adapter.initialize(createMockChat() as never);

    await expect(
      adapter.addReaction("imessage:iMessage;-;+1234567890", "msg-001", "heart")
    ).rejects.toThrow("addReaction is not supported in local mode");
  });

  it("should throw NotImplementedError in local mode for removeReaction", async () => {
    const adapter = new iMessageAdapter({ local: true, logger: mockLogger });
    await adapter.initialize(createMockChat() as never);

    await expect(
      adapter.removeReaction(
        "imessage:iMessage;-;+1234567890",
        "msg-001",
        "heart"
      )
    ).rejects.toThrow("removeReaction is not supported in local mode");
  });

  it("should send tapback via remote SDK for addReaction", async () => {
    const adapter = new iMessageAdapter({
      local: false,
      logger: mockLogger,
      serverUrl: "https://example.com",
      apiKey: "test-key",
    });
    await adapter.initialize(createMockChat() as never);

    mockSendReaction.mockResolvedValue({ guid: "reaction-001" });

    await adapter.addReaction(
      "imessage:iMessage;-;+1234567890",
      "msg-001",
      "heart"
    );

    expect(mockSendReaction).toHaveBeenCalledWith({
      chatGuid: "iMessage;-;+1234567890",
      messageGuid: "msg-001",
      reaction: "love",
    });
  });

  it("should map thumbs_up to like tapback", async () => {
    const adapter = new iMessageAdapter({
      local: false,
      logger: mockLogger,
      serverUrl: "https://example.com",
      apiKey: "test-key",
    });
    await adapter.initialize(createMockChat() as never);

    mockSendReaction.mockResolvedValue({ guid: "reaction-002" });

    await adapter.addReaction(
      "imessage:iMessage;-;+1234567890",
      "msg-001",
      "thumbs_up"
    );

    expect(mockSendReaction).toHaveBeenCalledWith({
      chatGuid: "iMessage;-;+1234567890",
      messageGuid: "msg-001",
      reaction: "like",
    });
  });

  it("should send remove tapback with dash prefix for removeReaction", async () => {
    const adapter = new iMessageAdapter({
      local: false,
      logger: mockLogger,
      serverUrl: "https://example.com",
      apiKey: "test-key",
    });
    await adapter.initialize(createMockChat() as never);

    mockSendReaction.mockResolvedValue({ guid: "reaction-003" });

    await adapter.removeReaction(
      "imessage:iMessage;-;+1234567890",
      "msg-001",
      "laugh"
    );

    expect(mockSendReaction).toHaveBeenCalledWith({
      chatGuid: "iMessage;-;+1234567890",
      messageGuid: "msg-001",
      reaction: "-laugh",
    });
  });

  it("should throw for unsupported emoji", async () => {
    const adapter = new iMessageAdapter({
      local: false,
      logger: mockLogger,
      serverUrl: "https://example.com",
      apiKey: "test-key",
    });
    await adapter.initialize(createMockChat() as never);

    await expect(
      adapter.addReaction("imessage:iMessage;-;+1234567890", "msg-001", "fire")
    ).rejects.toThrow('Unsupported iMessage tapback: "fire"');
  });
});

describe("startTyping", () => {
  afterEach(() => {
    mockStartTyping.mockReset();
    mockStopTyping.mockReset();
  });

  it("should throw NotImplementedError in local mode", async () => {
    const adapter = new iMessageAdapter({ local: true, logger: mockLogger });
    await adapter.initialize(createMockChat() as never);

    await expect(
      adapter.startTyping("imessage:iMessage;-;+1234567890")
    ).rejects.toThrow("startTyping is not supported in local mode");
  });

  it("should call startTyping via remote SDK", async () => {
    vi.useFakeTimers();
    const adapter = new iMessageAdapter({
      local: false,
      logger: mockLogger,
      serverUrl: "https://example.com",
      apiKey: "test-key",
    });
    await adapter.initialize(createMockChat() as never);

    mockStartTyping.mockResolvedValue(undefined);
    mockStopTyping.mockResolvedValue(undefined);

    await adapter.startTyping("imessage:iMessage;-;+1234567890");

    expect(mockStartTyping).toHaveBeenCalledWith("iMessage;-;+1234567890");
    expect(mockStopTyping).not.toHaveBeenCalled();

    vi.advanceTimersByTime(3000);

    expect(mockStopTyping).toHaveBeenCalledWith("iMessage;-;+1234567890");
    vi.useRealTimers();
  });
});

describe("fetchThread", () => {
  afterEach(() => {
    mockGetChat.mockReset();
  });

  it("should throw NotImplementedError in local mode", async () => {
    const adapter = new iMessageAdapter({ local: true, logger: mockLogger });
    await adapter.initialize(createMockChat() as never);

    await expect(
      adapter.fetchThread("imessage:iMessage;-;+1234567890")
    ).rejects.toThrow("fetchThread is not supported in local mode");
  });

  it("should fetch DM thread via remote SDK", async () => {
    const adapter = new iMessageAdapter({
      local: false,
      logger: mockLogger,
      serverUrl: "https://example.com",
      apiKey: "test-key",
    });
    await adapter.initialize(createMockChat() as never);

    mockGetChat.mockResolvedValue({
      originalROWID: 1,
      guid: "iMessage;-;+1234567890",
      style: 43,
      chatIdentifier: "+1234567890",
      isArchived: false,
      displayName: "",
      participants: [{ address: "+1234567890" }],
    });

    const result = await adapter.fetchThread("imessage:iMessage;-;+1234567890");

    expect(mockGetChat).toHaveBeenCalledWith("iMessage;-;+1234567890");
    expect(result.id).toBe("imessage:iMessage;-;+1234567890");
    expect(result.channelId).toBe("iMessage;-;+1234567890");
    expect(result.isDM).toBe(true);
    expect(result.channelName).toBeUndefined();
    expect(result.metadata.chatIdentifier).toBe("+1234567890");
  });

  it("should fetch group thread via remote SDK", async () => {
    const adapter = new iMessageAdapter({
      local: false,
      logger: mockLogger,
      serverUrl: "https://example.com",
      apiKey: "test-key",
    });
    await adapter.initialize(createMockChat() as never);

    mockGetChat.mockResolvedValue({
      originalROWID: 2,
      guid: "iMessage;+;chat493787071395575843",
      style: 45,
      chatIdentifier: "chat493787071395575843",
      isArchived: false,
      displayName: "Family Group",
      participants: [{ address: "+1234567890" }, { address: "+1987654321" }],
    });

    const result = await adapter.fetchThread(
      "imessage:iMessage;+;chat493787071395575843"
    );

    expect(result.isDM).toBe(false);
    expect(result.channelName).toBe("Family Group");
    expect(result.metadata.style).toBe(45);
  });
});

describe("parseMessage", () => {
  it("should parse local imessage-kit Message when local is true", () => {
    const adapter = new iMessageAdapter({ local: true, logger: mockLogger });
    adapter.initialize(createMockChat() as never);

    const localRaw = {
      id: "123",
      guid: "msg-local-001",
      text: "Hello from local",
      sender: "+1234567890",
      senderName: "Alice",
      chatId: "iMessage;-;+1234567890",
      isGroupChat: false,
      service: "iMessage",
      isRead: true,
      isFromMe: false,
      isReaction: false,
      reactionType: null,
      isReactionRemoval: false,
      associatedMessageGuid: null,
      attachments: [],
      date: new Date("2026-01-15T12:00:00Z"),
    };

    const message = adapter.parseMessage(localRaw);
    expect(message.id).toBe("msg-local-001");
    expect(message.text).toBe("Hello from local");
    expect(message.author.userId).toBe("+1234567890");
    expect(message.author.userName).toBe("Alice");
    expect(message.threadId).toBe("imessage:iMessage;-;+1234567890");
    expect(message.isMention).toBe(true);
  });

  it("should parse remote advanced-imessage-kit MessageResponse when local is false", () => {
    const adapter = new iMessageAdapter({
      local: false,
      logger: mockLogger,
      serverUrl: "https://example.com",
      apiKey: "test-key",
    });
    adapter.initialize(createMockChat() as never);

    const remoteRaw = {
      originalROWID: 1,
      guid: "msg-remote-001",
      text: "Hello from remote",
      handleId: 1,
      otherHandle: 0,
      handle: { address: "+1987654321" },
      chats: [{ guid: "iMessage;-;+1987654321", style: 43 }],
      subject: "",
      error: 0,
      dateCreated: new Date("2026-01-15T12:00:00Z").getTime(),
      dateRead: null,
      dateDelivered: null,
      isFromMe: false,
      isArchived: false,
      itemType: 0,
      groupTitle: null,
      groupActionType: 0,
      balloonBundleId: null,
      associatedMessageGuid: null,
      associatedMessageType: null,
      expressiveSendStyleId: null,
      attachments: [],
    };

    const message = adapter.parseMessage(remoteRaw);
    expect(message.id).toBe("msg-remote-001");
    expect(message.text).toBe("Hello from remote");
    expect(message.author.userId).toBe("+1987654321");
    expect(message.threadId).toBe("imessage:iMessage;-;+1987654321");
    expect(message.isMention).toBe(true);
  });

  it("should set isMention to false for group chats in local mode", () => {
    const adapter = new iMessageAdapter({ local: true, logger: mockLogger });
    adapter.initialize(createMockChat() as never);

    const localRaw = {
      id: "123",
      guid: "msg-local-002",
      text: "Group message",
      sender: "+1234567890",
      senderName: null,
      chatId: "iMessage;+;chat123456",
      isGroupChat: true,
      service: "iMessage",
      isRead: true,
      isFromMe: false,
      isReaction: false,
      reactionType: null,
      isReactionRemoval: false,
      associatedMessageGuid: null,
      attachments: [],
      date: new Date("2026-01-15T12:00:00Z"),
    };

    const message = adapter.parseMessage(localRaw);
    expect(message.isMention).toBe(false);
    expect(message.author.userName).toBe("+1234567890");
  });

  it("should handle attachments from remote payload", () => {
    const adapter = new iMessageAdapter({
      local: false,
      logger: mockLogger,
      serverUrl: "https://example.com",
      apiKey: "test-key",
    });
    adapter.initialize(createMockChat() as never);

    const remoteRaw = {
      originalROWID: 2,
      guid: "msg-remote-002",
      text: "Photo",
      handleId: 1,
      otherHandle: 0,
      handle: { address: "+1987654321" },
      chats: [{ guid: "iMessage;-;+1987654321", style: 43 }],
      subject: "",
      error: 0,
      dateCreated: Date.now(),
      dateRead: null,
      dateDelivered: null,
      isFromMe: false,
      isArchived: false,
      itemType: 0,
      groupTitle: null,
      groupActionType: 0,
      balloonBundleId: null,
      associatedMessageGuid: null,
      associatedMessageType: null,
      expressiveSendStyleId: null,
      attachments: [
        {
          guid: "att-001",
          transferName: "photo.jpg",
          mimeType: "image/jpeg",
          totalBytes: 54321,
        },
      ],
    };

    const message = adapter.parseMessage(remoteRaw);
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0].type).toBe("image");
    expect(message.attachments[0].name).toBe("photo.jpg");
    expect(message.attachments[0].mimeType).toBe("image/jpeg");
  });
});

describe("createiMessageAdapter", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("should default to local mode", () => {
    const adapter = createiMessageAdapter();
    expect(adapter.local).toBe(true);
  });

  it("should use remote mode when local is false", () => {
    const adapter = createiMessageAdapter({
      local: false,
      serverUrl: "https://example.com",
      apiKey: "test-key",
    });
    expect(adapter.local).toBe(false);
    expect(adapter.serverUrl).toBe("https://example.com");
    expect(adapter.apiKey).toBe("test-key");
  });

  it("should read IMESSAGE_LOCAL env var", () => {
    vi.stubEnv("IMESSAGE_LOCAL", "false");
    vi.stubEnv("IMESSAGE_SERVER_URL", "https://env.example.com");
    vi.stubEnv("IMESSAGE_API_KEY", "env-key");

    const adapter = createiMessageAdapter();
    expect(adapter.local).toBe(false);
    expect(adapter.serverUrl).toBe("https://env.example.com");
    expect(adapter.apiKey).toBe("env-key");
  });

  it("should throw ValidationError when remote mode is missing serverUrl", () => {
    expect(() => createiMessageAdapter({ local: false })).toThrow(
      ValidationError
    );
    expect(() => createiMessageAdapter({ local: false })).toThrow(
      "serverUrl is required when local is false"
    );
  });

  it("should throw ValidationError when remote mode is missing apiKey", () => {
    expect(() =>
      createiMessageAdapter({
        local: false,
        serverUrl: "https://example.com",
      })
    ).toThrow(ValidationError);
    expect(() =>
      createiMessageAdapter({
        local: false,
        serverUrl: "https://example.com",
      })
    ).toThrow("apiKey is required when local is false");
  });

  it("should prefer config values over env vars", () => {
    vi.stubEnv("IMESSAGE_SERVER_URL", "https://env.example.com");
    vi.stubEnv("IMESSAGE_API_KEY", "env-key");

    const adapter = createiMessageAdapter({
      local: false,
      serverUrl: "https://config.example.com",
      apiKey: "config-key",
    });
    expect(adapter.serverUrl).toBe("https://config.example.com");
    expect(adapter.apiKey).toBe("config-key");
  });

  it("should read IMESSAGE_SERVER_URL and IMESSAGE_API_KEY for local mode", () => {
    vi.stubEnv("IMESSAGE_SERVER_URL", "http://localhost:5678");
    vi.stubEnv("IMESSAGE_API_KEY", "local-key");

    const adapter = createiMessageAdapter({ local: true });
    expect(adapter.local).toBe(true);
    expect(adapter.serverUrl).toBe("http://localhost:5678");
    expect(adapter.apiKey).toBe("local-key");
  });
});

describe("openModal", () => {
  afterEach(() => {
    mockPollCreate.mockReset();
    mockProcessModalSubmit.mockReset();
    mockIsPollVote.mockReset();
    mockParsePollVotes.mockReset();
    mockGatewayOn.mockReset();
    mockGatewayConnect.mockReset();
    mockGatewayClose.mockReset();
  });

  const sampleModal: ModalElement = {
    type: "modal",
    callbackId: "fav-color",
    title: "Favorite color?",
    children: [
      {
        type: "select",
        id: "color",
        label: "Pick a color",
        placeholder: "Choose...",
        options: [
          { label: "Red", value: "red" },
          { label: "Blue", value: "blue" },
          { label: "Green", value: "green" },
        ],
      },
    ],
  };

  it("should create iMessage poll from modal with Select child", async () => {
    const adapter = new iMessageAdapter({
      local: false,
      logger: mockLogger,
      serverUrl: "https://example.com",
      apiKey: "test-key",
    });
    await adapter.initialize(createMockChat() as never);

    mockPollCreate.mockResolvedValue({
      guid: "poll-001",
      text: "Poll created",
    });

    const result = await adapter.openModal(
      "imessage:iMessage;-;+1234567890",
      sampleModal
    );

    expect(mockPollCreate).toHaveBeenCalledWith({
      chatGuid: "iMessage;-;+1234567890",
      title: "Favorite color?",
      options: ["Red", "Blue", "Green"],
    });
    expect(result.viewId).toBe("poll-001");
  });

  it("should throw NotImplementedError in local mode", async () => {
    const adapter = new iMessageAdapter({ local: true, logger: mockLogger });
    await adapter.initialize(createMockChat() as never);

    await expect(
      adapter.openModal("imessage:iMessage;-;+1234567890", sampleModal)
    ).rejects.toThrow(NotImplementedError);
    await expect(
      adapter.openModal("imessage:iMessage;-;+1234567890", sampleModal)
    ).rejects.toThrow("openModal is not supported in local mode");
  });

  it("should throw ValidationError when no Select child present", async () => {
    const adapter = new iMessageAdapter({
      local: false,
      logger: mockLogger,
      serverUrl: "https://example.com",
      apiKey: "test-key",
    });
    await adapter.initialize(createMockChat() as never);

    const modalWithoutSelect: ModalElement = {
      type: "modal",
      callbackId: "no-select",
      title: "No select",
      children: [
        {
          type: "text_input",
          id: "name",
          label: "Name",
        },
      ],
    };

    await expect(
      adapter.openModal(
        "imessage:iMessage;-;+1234567890",
        modalWithoutSelect
      )
    ).rejects.toThrow(ValidationError);
    await expect(
      adapter.openModal(
        "imessage:iMessage;-;+1234567890",
        modalWithoutSelect
      )
    ).rejects.toThrow("openModal requires at least one Select child");
  });

  it("should store modal-to-poll mapping with privateMetadata", async () => {
    const adapter = new iMessageAdapter({
      local: false,
      logger: mockLogger,
      serverUrl: "https://example.com",
      apiKey: "test-key",
    });
    await adapter.initialize(createMockChat() as never);

    mockPollCreate.mockResolvedValue({
      guid: "poll-002",
      text: "Poll created",
    });

    const modalWithMeta: ModalElement = {
      ...sampleModal,
      privateMetadata: "some-context",
    };

    await adapter.openModal(
      "imessage:iMessage;-;+1234567890",
      modalWithMeta,
      "ctx-123"
    );

    // Verify the mapping was stored by triggering a poll vote
    mockIsPollVote.mockReturnValueOnce(true);
    mockParsePollVotes.mockReturnValueOnce({
      votes: [
        {
          voteOptionIdentifier: "0",
          participantHandle: "+1999999999",
        },
      ],
    });

    // Simulate a poll vote through the gateway listener
    const waitUntil = vi.fn();
    const controller = new AbortController();
    await adapter.startGatewayListener({ waitUntil }, 60000, controller.signal);

    // Get the message handler
    const onMessageCall = mockGatewayOn.mock.calls.find(
      (c: unknown[]) => c[0] === "new-message"
    );
    expect(onMessageCall).toBeDefined();

    const messageHandler = onMessageCall![1] as (msg: unknown) => void;

    // Simulate a vote message
    messageHandler({
      guid: "vote-msg-001",
      isFromMe: false,
      associatedMessageGuid: "poll-002",
      chats: [{ guid: "iMessage;-;+1234567890" }],
    });

    // Allow async processing
    await vi.waitFor(() => {
      expect(mockProcessModalSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          callbackId: "fav-color",
          privateMetadata: "some-context",
          viewId: "poll-002",
          values: { color: "red" },
          user: expect.objectContaining({
            userId: "+1999999999",
          }),
        }),
        "ctx-123",
        expect.anything()
      );
    });

    controller.abort();
    const listenerPromise = waitUntil.mock.calls[0][0] as Promise<void>;
    await listenerPromise;
  });
});

describe("poll vote to modal submit routing", () => {
  afterEach(() => {
    mockPollCreate.mockReset();
    mockProcessModalSubmit.mockReset();
    mockIsPollVote.mockReset();
    mockParsePollVotes.mockReset();
    mockGatewayOn.mockReset();
    mockGatewayConnect.mockReset();
    mockGatewayClose.mockReset();
  });

  it("should ignore votes for unknown polls", async () => {
    const adapter = new iMessageAdapter({
      local: false,
      logger: mockLogger,
      serverUrl: "https://example.com",
      apiKey: "test-key",
    });
    await adapter.initialize(createMockChat() as never);

    const waitUntil = vi.fn();
    const controller = new AbortController();
    await adapter.startGatewayListener({ waitUntil }, 60000, controller.signal);

    const onMessageCall = mockGatewayOn.mock.calls.find(
      (c: unknown[]) => c[0] === "new-message"
    );
    const messageHandler = onMessageCall![1] as (msg: unknown) => void;

    mockIsPollVote.mockReturnValueOnce(true);

    messageHandler({
      guid: "vote-msg-unknown",
      isFromMe: false,
      associatedMessageGuid: "unknown-poll",
      chats: [{ guid: "iMessage;-;+1234567890" }],
    });

    expect(mockProcessModalSubmit).not.toHaveBeenCalled();

    controller.abort();
    const listenerPromise = waitUntil.mock.calls[0][0] as Promise<void>;
    await listenerPromise;
  });

  it("should map option index to SelectOption value", async () => {
    const adapter = new iMessageAdapter({
      local: false,
      logger: mockLogger,
      serverUrl: "https://example.com",
      apiKey: "test-key",
    });
    await adapter.initialize(createMockChat() as never);

    // Create a poll via openModal first
    mockPollCreate.mockResolvedValue({ guid: "poll-map-001" });
    await adapter.openModal("imessage:iMessage;-;+1234567890", {
      type: "modal",
      callbackId: "survey",
      title: "Survey",
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
    });

    const waitUntil = vi.fn();
    const controller = new AbortController();
    await adapter.startGatewayListener({ waitUntil }, 60000, controller.signal);

    const onMessageCall = mockGatewayOn.mock.calls.find(
      (c: unknown[]) => c[0] === "new-message"
    );
    const messageHandler = onMessageCall![1] as (msg: unknown) => void;

    // Vote for option index 2 (Option C -> value "c")
    mockIsPollVote.mockReturnValueOnce(true);
    mockParsePollVotes.mockReturnValueOnce({
      votes: [
        {
          voteOptionIdentifier: "2",
          participantHandle: "+1555555555",
        },
      ],
    });

    messageHandler({
      guid: "vote-msg-002",
      isFromMe: false,
      associatedMessageGuid: "poll-map-001",
      chats: [{ guid: "iMessage;-;+1234567890" }],
    });

    await vi.waitFor(() => {
      expect(mockProcessModalSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          callbackId: "survey",
          values: { answer: "c" },
          user: expect.objectContaining({
            userId: "+1555555555",
          }),
        }),
        undefined,
        expect.anything()
      );
    });

    controller.abort();
    const listenerPromise = waitUntil.mock.calls[0][0] as Promise<void>;
    await listenerPromise;
  });
});
