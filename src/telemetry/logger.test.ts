import { describe, expect, it, vi } from "vitest";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { context } from "@opentelemetry/api";

import { OTelLogger } from "./logger";

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

type Emit = ReturnType<typeof vi.fn>;

interface MockDelegate {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
  child: ReturnType<typeof vi.fn>;
}

/**
 * Cast constructor so we can pass plain objects instead of satisfying
 * the full Logger / LoggerProvider interfaces.
 */
const LoggerCtor = OTelLogger as unknown as {
  new (
    delegate: MockDelegate,
    provider: { getLogger: () => { emit: Emit } },
    name?: string,
    baseAttributes?: Record<string, string | number | boolean>,
  ): OTelLogger;
};

function createLogger(opts?: {
  emit?: Emit;
  delegate?: MockDelegate;
  name?: string;
  baseAttributes?: Record<string, string | number | boolean>;
}) {
  const emit = opts?.emit ?? vi.fn();
  const delegate: MockDelegate = opts?.delegate ?? {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnValue({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn(),
    }),
  };

  const logger = new LoggerCtor(
    delegate,
    { getLogger: () => ({ emit }) },
    opts?.name ?? "test",
    opts?.baseAttributes,
  );

  return { logger, emit, delegate };
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe("OTelLogger", () => {
  it("merges base attributes into emitted log records", () => {
    const { logger, emit } = createLogger({
      baseAttributes: { "service.name": "imessage-bot" },
    });

    logger.info("hello", { foo: "bar" });

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        attributes: {
          "service.name": "imessage-bot",
          foo: "bar",
        },
      }),
    );
  });

  /* -------------------------------------------------------------- */
  /* Log level delegation + OTel emission                            */
  /* -------------------------------------------------------------- */

  describe.each([
    { level: "info" as const, severity: SeverityNumber.INFO, text: "INFO" },
    { level: "warn" as const, severity: SeverityNumber.WARN, text: "WARN" },
    { level: "error" as const, severity: SeverityNumber.ERROR, text: "ERROR" },
    { level: "debug" as const, severity: SeverityNumber.DEBUG, text: "DEBUG" },
  ])("$level()", ({ level, severity, text }) => {
    it("delegates to the original logger", () => {
      const { logger, delegate } = createLogger();
      const meta = { key: "value" };

      logger[level]("msg", meta);

      expect(delegate[level]).toHaveBeenCalledWith("msg", meta);
    });

    it(`emits OTel record with SeverityNumber=${severity} / SeverityText="${text}"`, () => {
      const { logger, emit } = createLogger();

      logger[level]("msg");

      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({
          severityNumber: severity,
          severityText: text,
          body: "msg",
        }),
      );
    });
  });

  /* -------------------------------------------------------------- */
  /* child()                                                         */
  /* -------------------------------------------------------------- */

  describe("child()", () => {
    it("calls delegate.child with the given name", () => {
      const { logger, delegate } = createLogger({ name: "parent" });

      logger.child("sub");

      expect(delegate.child).toHaveBeenCalledWith("sub");
    });

    it("returns an OTelLogger that appends the child name", () => {
      const childEmit = vi.fn();
      const childDelegate: MockDelegate = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        child: vi.fn(),
      };

      const parentDelegate: MockDelegate = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        child: vi.fn().mockReturnValue(childDelegate),
      };

      const getLogger = vi.fn().mockReturnValue({ emit: childEmit });

      const parent = new LoggerCtor(
        parentDelegate,
        { getLogger },
        "root",
        { env: "test" },
      );

      // getLogger is called once for the parent during construction
      expect(getLogger).toHaveBeenCalledTimes(1);

      const child = parent.child("sub") as OTelLogger;

      // getLogger called again for the child with appended name
      expect(getLogger).toHaveBeenCalledTimes(2);
      expect(getLogger).toHaveBeenLastCalledWith("root.sub", expect.any(String));

      // Child still emits logs correctly
      child.info("child-msg", { x: 1 });
      expect(childDelegate.info).toHaveBeenCalledWith("child-msg", { x: 1 });
      expect(childEmit).toHaveBeenCalledWith(
        expect.objectContaining({
          body: "child-msg",
          attributes: expect.objectContaining({ env: "test", x: 1 }),
        }),
      );
    });

    it("inherits baseAttributes from the parent", () => {
      const childEmit = vi.fn();
      const childDelegate: MockDelegate = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        child: vi.fn(),
      };

      const parentDelegate: MockDelegate = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        child: vi.fn().mockReturnValue(childDelegate),
      };

      const parent = new LoggerCtor(
        parentDelegate,
        { getLogger: () => ({ emit: childEmit }) },
        "root",
        { "service.name": "svc", region: "us-east-1" },
      );

      const child = parent.child("worker") as OTelLogger;
      child.warn("caution");

      expect(childEmit).toHaveBeenCalledWith(
        expect.objectContaining({
          attributes: {
            "service.name": "svc",
            region: "us-east-1",
          },
        }),
      );
    });
  });

  /* -------------------------------------------------------------- */
  /* Metadata flattening                                             */
  /* -------------------------------------------------------------- */

  describe("metadata flattening", () => {
    it("passes string, number, and boolean values through unchanged", () => {
      const { logger, emit } = createLogger();

      logger.info("msg", { str: "hello", num: 42, bool: true });

      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({
          attributes: expect.objectContaining({
            str: "hello",
            num: 42,
            bool: true,
          }),
        }),
      );
    });

    it("converts object values to strings via String()", () => {
      const { logger, emit } = createLogger();

      logger.info("msg", { nested: { a: 1 } });

      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({
          attributes: expect.objectContaining({
            nested: "[object Object]",
          }),
        }),
      );
    });

    it("converts arrays to strings via String()", () => {
      const { logger, emit } = createLogger();

      logger.info("msg", { list: [1, 2, 3] });

      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({
          attributes: expect.objectContaining({
            list: "1,2,3",
          }),
        }),
      );
    });

    it("converts null to string 'null'", () => {
      const { logger, emit } = createLogger();

      logger.info("msg", { empty: null });

      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({
          attributes: expect.objectContaining({
            empty: "null",
          }),
        }),
      );
    });

    it("converts undefined to string 'undefined'", () => {
      const { logger, emit } = createLogger();

      logger.info("msg", { missing: undefined });

      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({
          attributes: expect.objectContaining({
            missing: "undefined",
          }),
        }),
      );
    });
  });

  /* -------------------------------------------------------------- */
  /* No metadata / no baseAttributes                                 */
  /* -------------------------------------------------------------- */

  describe("attributes omission", () => {
    it("sets attributes to undefined when no baseAttributes and no metadata", () => {
      const { logger, emit } = createLogger({ baseAttributes: undefined });

      logger.info("bare message");

      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({
          attributes: undefined,
        }),
      );
    });

    it("sets attributes to undefined when baseAttributes is empty and no metadata", () => {
      const { logger, emit } = createLogger({ baseAttributes: {} });

      logger.info("bare message");

      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({
          attributes: undefined,
        }),
      );
    });

    it("includes only baseAttributes when metadata is omitted", () => {
      const { logger, emit } = createLogger({
        baseAttributes: { env: "prod" },
      });

      logger.info("no-meta message");

      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({
          attributes: { env: "prod" },
        }),
      );
    });
  });

  /* -------------------------------------------------------------- */
  /* Context correlation                                             */
  /* -------------------------------------------------------------- */

  describe("context correlation", () => {
    it("passes context.active() to the emitted log record", () => {
      const { logger, emit } = createLogger();
      const activeCtx = context.active();

      logger.info("correlated");

      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({
          context: activeCtx,
        }),
      );
    });
  });

  /* -------------------------------------------------------------- */
  /* OTelLogger resilience                                           */
  /* -------------------------------------------------------------- */

  describe("OTelLogger resilience", () => {
    it("does not throw when emit() throws on info", () => {
      const delegate = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };
      const provider = {
        getLogger: () => ({ emit: () => { throw new Error("emit exploded"); } }),
      };
      const logger = new OTelLogger(delegate as never, provider as never);
      expect(() => logger.info("test message")).not.toThrow();
      expect(delegate.info).toHaveBeenCalledWith("test message", undefined);
    });

    it("does not throw when emit() throws for warn, error, debug", () => {
      const delegate = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };
      const provider = {
        getLogger: () => ({ emit: () => { throw new Error("emit exploded"); } }),
      };
      const logger = new OTelLogger(delegate as never, provider as never);
      expect(() => logger.warn("w")).not.toThrow();
      expect(() => logger.error("e")).not.toThrow();
      expect(() => logger.debug("d")).not.toThrow();
      expect(delegate.warn).toHaveBeenCalled();
      expect(delegate.error).toHaveBeenCalled();
      expect(delegate.debug).toHaveBeenCalled();
    });
  });
});
