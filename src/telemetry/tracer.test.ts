import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import {
  trace,
  SpanStatusCode,
  SpanKind,
  type Span,
  type Tracer,
  type TracerProvider,
} from "@opentelemetry/api";

import { createTracer, withSpan, withSyncSpan } from "./tracer";
import { LIBRARY_NAME, LIBRARY_VERSION } from "./config";

// ---------------------------------------------------------------------------
// Helpers — mock span / tracer factories
// ---------------------------------------------------------------------------

function createMockSpan(): Span & {
  setAttribute: ReturnType<typeof vi.fn>;
  setStatus: ReturnType<typeof vi.fn>;
  recordException: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
} {
  return {
    spanContext: vi.fn().mockReturnValue({
      traceId: "abc123",
      spanId: "def456",
      traceFlags: 1,
    }),
    setAttribute: vi.fn(),
    setAttributes: vi.fn(),
    addEvent: vi.fn(),
    addLink: vi.fn(),
    addLinks: vi.fn(),
    setStatus: vi.fn(),
    updateName: vi.fn(),
    isRecording: vi.fn().mockReturnValue(true),
    recordException: vi.fn(),
    end: vi.fn(),
  } as unknown as Span & {
    setAttribute: ReturnType<typeof vi.fn>;
    setStatus: ReturnType<typeof vi.fn>;
    recordException: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
}

function createMockTracer(mockSpan: Span): Tracer {
  return {
    startSpan: vi.fn().mockReturnValue(mockSpan),
    startActiveSpan: vi.fn().mockImplementation(
      (_name: string, _options: unknown, fn: (span: Span) => unknown) => {
        return fn(mockSpan);
      },
    ),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createTracer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the provided TracerProvider", () => {
    const mockTracer = {} as Tracer;
    const mockProvider: TracerProvider = {
      getTracer: vi.fn().mockReturnValue(mockTracer),
    };

    const result = createTracer(mockProvider);

    expect(result).toBe(mockTracer);
    expect(mockProvider.getTracer).toHaveBeenCalledWith(
      LIBRARY_NAME,
      LIBRARY_VERSION,
    );
  });

  it("falls back to the global TracerProvider when none is supplied", () => {
    const mockTracer = {} as Tracer;
    const globalProvider: TracerProvider = {
      getTracer: vi.fn().mockReturnValue(mockTracer),
    };
    vi.spyOn(trace, "getTracerProvider").mockReturnValue(globalProvider);

    const result = createTracer();

    expect(result).toBe(mockTracer);
    expect(globalProvider.getTracer).toHaveBeenCalledWith(
      LIBRARY_NAME,
      LIBRARY_VERSION,
    );
  });
});

describe("withSpan", () => {
  let mockSpan: ReturnType<typeof createMockSpan>;
  let mockTracer: Tracer;

  beforeEach(() => {
    mockSpan = createMockSpan();
    mockTracer = createMockTracer(mockSpan);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -- disabled path (existing tests) -------------------------------------

  it("does not ask the global tracer for spans when disabled", async () => {
    const getTracerSpy = vi.spyOn(trace, "getTracer");

    const result = await withSpan(null, "test", {}, async (span) => {
      span.setAttribute("checked", true);
      return "ok";
    });

    expect(result).toBe("ok");
    expect(getTracerSpy).not.toHaveBeenCalled();
  });

  it("does not ask the global tracer for sync spans when disabled", () => {
    const getTracerSpy = vi.spyOn(trace, "getTracer");

    const result = withSyncSpan(null, "test", {}, (span) => {
      span.setAttribute("checked", true);
      return "ok";
    });

    expect(result).toBe("ok");
    expect(getTracerSpy).not.toHaveBeenCalled();
  });

  // -- enabled path: success ----------------------------------------------

  it("creates a span with name, attributes, and kind and returns the result", async () => {
    const attrs = { "rpc.method": "send", "rpc.service": "iMessage" };

    const result = await withSpan(
      mockTracer,
      "send-message",
      attrs,
      async () => "delivered",
      SpanKind.CLIENT,
    );

    expect(result).toBe("delivered");
    expect(mockTracer.startActiveSpan).toHaveBeenCalledWith(
      "send-message",
      { attributes: attrs, kind: SpanKind.CLIENT },
      expect.any(Function),
    );
  });

  it("sets span status to OK on success", async () => {
    await withSpan(mockTracer, "op", {}, async () => "ok");

    expect(mockSpan.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.OK,
    });
  });

  it("calls span.end() on success", async () => {
    await withSpan(mockTracer, "op", {}, async () => "ok");

    expect(mockSpan.end).toHaveBeenCalledTimes(1);
  });

  it("passes the span to the callback", async () => {
    const receivedSpan = await withSpan(
      mockTracer,
      "op",
      {},
      async (span) => span,
    );

    expect(receivedSpan).toBe(mockSpan);
  });

  // -- enabled path: Error thrown -----------------------------------------

  it("sets span status to ERROR with the error message when an Error is thrown", async () => {
    const error = new Error("connection lost");

    await expect(
      withSpan(mockTracer, "op", {}, async () => {
        throw error;
      }),
    ).rejects.toThrow("connection lost");

    expect(mockSpan.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: "connection lost",
    });
  });

  it("records the exception on the span when an Error is thrown", async () => {
    const error = new Error("timeout");

    await expect(
      withSpan(mockTracer, "op", {}, async () => {
        throw error;
      }),
    ).rejects.toThrow("timeout");

    expect(mockSpan.recordException).toHaveBeenCalledWith(error);
  });

  it("re-throws the original error", async () => {
    const error = new Error("boom");

    await expect(
      withSpan(mockTracer, "op", {}, async () => {
        throw error;
      }),
    ).rejects.toThrow(error);
  });

  it("calls span.end() even when an error is thrown", async () => {
    await expect(
      withSpan(mockTracer, "op", {}, async () => {
        throw new Error("fail");
      }),
    ).rejects.toThrow();

    expect(mockSpan.end).toHaveBeenCalledTimes(1);
  });

  // -- enabled path: non-Error thrown (string) ----------------------------

  it("wraps a non-Error throwable in a new Error for recordException", async () => {
    await expect(
      withSpan(mockTracer, "op", {}, async () => {
        throw "string error";
      }),
    ).rejects.toThrow("string error");

    expect(mockSpan.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: "string error",
    });

    // recordException should receive a proper Error object
    const recordedArg = mockSpan.recordException.mock.calls[0][0];
    expect(recordedArg).toBeInstanceOf(Error);
    expect((recordedArg as Error).message).toBe("string error");
  });
});

describe("withSyncSpan", () => {
  let mockSpan: ReturnType<typeof createMockSpan>;
  let mockTracer: Tracer;

  beforeEach(() => {
    mockSpan = createMockSpan();
    mockTracer = createMockTracer(mockSpan);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -- enabled path: success ----------------------------------------------

  it("creates a span with name and attributes and returns the result", () => {
    const attrs = { "db.system": "sqlite" };

    const result = withSyncSpan(
      mockTracer,
      "db-query",
      attrs,
      () => 42,
    );

    expect(result).toBe(42);
    expect(mockTracer.startActiveSpan).toHaveBeenCalledWith(
      "db-query",
      { attributes: attrs },
      expect.any(Function),
    );
  });

  it("sets span status to OK on success", () => {
    withSyncSpan(mockTracer, "op", {}, () => "ok");

    expect(mockSpan.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.OK,
    });
  });

  it("calls span.end() on success", () => {
    withSyncSpan(mockTracer, "op", {}, () => "ok");

    expect(mockSpan.end).toHaveBeenCalledTimes(1);
  });

  it("passes the span to the callback", () => {
    const receivedSpan = withSyncSpan(mockTracer, "op", {}, (span) => span);

    expect(receivedSpan).toBe(mockSpan);
  });

  // -- enabled path: Error thrown -----------------------------------------

  it("sets span status to ERROR with the error message when an Error is thrown", () => {
    const error = new Error("parse failure");

    expect(() =>
      withSyncSpan(mockTracer, "op", {}, () => {
        throw error;
      }),
    ).toThrow("parse failure");

    expect(mockSpan.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: "parse failure",
    });
  });

  it("records the exception on the span when an Error is thrown", () => {
    const error = new Error("bad input");

    expect(() =>
      withSyncSpan(mockTracer, "op", {}, () => {
        throw error;
      }),
    ).toThrow();

    expect(mockSpan.recordException).toHaveBeenCalledWith(error);
  });

  it("re-throws the original error", () => {
    const error = new Error("kaboom");

    expect(() =>
      withSyncSpan(mockTracer, "op", {}, () => {
        throw error;
      }),
    ).toThrow(error);
  });

  it("calls span.end() even when an error is thrown", () => {
    expect(() =>
      withSyncSpan(mockTracer, "op", {}, () => {
        throw new Error("fail");
      }),
    ).toThrow();

    expect(mockSpan.end).toHaveBeenCalledTimes(1);
  });

  // -- enabled path: non-Error thrown (string) ----------------------------

  it("wraps a non-Error throwable in a new Error for recordException", () => {
    expect(() =>
      withSyncSpan(mockTracer, "op", {}, () => {
        throw "string error";
      }),
    ).toThrow("string error");

    expect(mockSpan.setStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: "string error",
    });

    const recordedArg = mockSpan.recordException.mock.calls[0][0];
    expect(recordedArg).toBeInstanceOf(Error);
    expect((recordedArg as Error).message).toBe("string error");
  });
});

// ---------------------------------------------------------------------------
// Resilience tests — span lifecycle methods throwing should not break callers
// ---------------------------------------------------------------------------

describe("withSpan resilience", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns result when span.setStatus throws after fn succeeds", async () => {
    const badSpan = createMockSpan();
    badSpan.setStatus.mockImplementation(() => {
      throw new Error("setStatus exploded");
    });
    const tracer = createMockTracer(badSpan);

    const result = await withSpan(tracer, "op", {}, async () => "hello");

    expect(result).toBe("hello");
  });

  it("propagates original error when span.recordException throws after fn throws", async () => {
    const badSpan = createMockSpan();
    badSpan.recordException.mockImplementation(() => {
      throw new Error("recordException exploded");
    });
    const tracer = createMockTracer(badSpan);

    await expect(
      withSpan(tracer, "op", {}, async () => {
        throw new Error("original error");
      }),
    ).rejects.toThrow("original error");
  });

  it("returns result when span.end throws after fn succeeds", async () => {
    const badSpan = createMockSpan();
    badSpan.end.mockImplementation(() => {
      throw new Error("end exploded");
    });
    const tracer = createMockTracer(badSpan);

    const result = await withSpan(tracer, "op", {}, async () => "hello");

    expect(result).toBe("hello");
  });

  it("propagates original error when span.end throws after fn throws", async () => {
    const badSpan = createMockSpan();
    badSpan.end.mockImplementation(() => {
      throw new Error("end exploded");
    });
    const tracer = createMockTracer(badSpan);

    await expect(
      withSpan(tracer, "op", {}, async () => {
        throw new Error("original error");
      }),
    ).rejects.toThrow("original error");
  });
});

describe("withSyncSpan resilience", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns result when span.setStatus throws after fn succeeds", () => {
    const badSpan = createMockSpan();
    badSpan.setStatus.mockImplementation(() => {
      throw new Error("setStatus exploded");
    });
    const tracer = createMockTracer(badSpan);

    const result = withSyncSpan(tracer, "op", {}, () => "hello");

    expect(result).toBe("hello");
  });

  it("propagates original error when span.recordException throws after fn throws", () => {
    const badSpan = createMockSpan();
    badSpan.recordException.mockImplementation(() => {
      throw new Error("recordException exploded");
    });
    const tracer = createMockTracer(badSpan);

    expect(() =>
      withSyncSpan(tracer, "op", {}, () => {
        throw new Error("original error");
      }),
    ).toThrow("original error");
  });

  it("returns result when span.end throws after fn succeeds", () => {
    const badSpan = createMockSpan();
    badSpan.end.mockImplementation(() => {
      throw new Error("end exploded");
    });
    const tracer = createMockTracer(badSpan);

    const result = withSyncSpan(tracer, "op", {}, () => "hello");

    expect(result).toBe("hello");
  });

  it("propagates original error when span.end throws after fn throws", () => {
    const badSpan = createMockSpan();
    badSpan.end.mockImplementation(() => {
      throw new Error("end exploded");
    });
    const tracer = createMockTracer(badSpan);

    expect(() =>
      withSyncSpan(tracer, "op", {}, () => {
        throw new Error("original error");
      }),
    ).toThrow("original error");
  });
});
