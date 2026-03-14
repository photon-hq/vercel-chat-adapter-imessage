import { afterEach, describe, expect, it, vi } from "vitest";
import { metrics, type MeterProvider, type Meter } from "@opentelemetry/api";
import { LIBRARY_NAME, LIBRARY_VERSION } from "./config";

describe("createMeter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("uses the provided MeterProvider and calls getMeter with LIBRARY_NAME/VERSION", async () => {
    const fakeMeter = {} as Meter;
    const fakeProvider: MeterProvider = {
      getMeter: vi.fn().mockReturnValue(fakeMeter),
    };

    const { createMeter } = await import("./metrics");
    const result = createMeter(fakeProvider);

    expect(fakeProvider.getMeter).toHaveBeenCalledWith(
      LIBRARY_NAME,
      LIBRARY_VERSION,
    );
    expect(result).toBe(fakeMeter);
  });

  it("falls back to the global MeterProvider when no provider is given", async () => {
    const fakeMeter = {} as Meter;
    const fakeGlobalProvider: MeterProvider = {
      getMeter: vi.fn().mockReturnValue(fakeMeter),
    };
    vi.spyOn(metrics, "getMeterProvider").mockReturnValue(fakeGlobalProvider);

    const { createMeter } = await import("./metrics");
    const result = createMeter();

    expect(metrics.getMeterProvider).toHaveBeenCalled();
    expect(fakeGlobalProvider.getMeter).toHaveBeenCalledWith(
      LIBRARY_NAME,
      LIBRARY_VERSION,
    );
    expect(result).toBe(fakeMeter);
  });
});

describe("AdapterMetrics", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("creates all 11 counters, 6 histograms, and 1 upDownCounter via the meter", async () => {
    const stubCounter = { add() {} };
    const stubHistogram = { record() {} };
    const stubUpDownCounter = { add() {} };

    const fakeMeter = {
      createCounter: vi.fn().mockReturnValue(stubCounter),
      createHistogram: vi.fn().mockReturnValue(stubHistogram),
      createUpDownCounter: vi.fn().mockReturnValue(stubUpDownCounter),
    } as unknown as Meter;

    const { AdapterMetrics } = await import("./metrics");
    const m = new AdapterMetrics(fakeMeter);

    // 11 counters
    expect(fakeMeter.createCounter).toHaveBeenCalledTimes(11);
    expect(fakeMeter.createCounter).toHaveBeenCalledWith(
      "imessage.messages.received",
      expect.objectContaining({ description: expect.any(String) }),
    );
    expect(fakeMeter.createCounter).toHaveBeenCalledWith(
      "imessage.messages.sent",
      expect.objectContaining({ description: expect.any(String) }),
    );
    expect(fakeMeter.createCounter).toHaveBeenCalledWith(
      "imessage.messages.send_errors",
      expect.objectContaining({ description: expect.any(String) }),
    );
    expect(fakeMeter.createCounter).toHaveBeenCalledWith(
      "imessage.gateway.sessions",
      expect.objectContaining({ description: expect.any(String) }),
    );
    expect(fakeMeter.createCounter).toHaveBeenCalledWith(
      "imessage.gateway.errors",
      expect.objectContaining({ description: expect.any(String) }),
    );
    expect(fakeMeter.createCounter).toHaveBeenCalledWith(
      "imessage.reactions.sent",
      expect.objectContaining({ description: expect.any(String) }),
    );
    expect(fakeMeter.createCounter).toHaveBeenCalledWith(
      "imessage.polls.created",
      expect.objectContaining({ description: expect.any(String) }),
    );
    expect(fakeMeter.createCounter).toHaveBeenCalledWith(
      "imessage.polls.votes_received",
      expect.objectContaining({ description: expect.any(String) }),
    );
    expect(fakeMeter.createCounter).toHaveBeenCalledWith(
      "imessage.polls.votes_dropped",
      expect.objectContaining({ description: expect.any(String) }),
    );
    expect(fakeMeter.createCounter).toHaveBeenCalledWith(
      "imessage.attachments.sent",
      expect.objectContaining({ description: expect.any(String) }),
    );
    expect(fakeMeter.createCounter).toHaveBeenCalledWith(
      "imessage.init.errors",
      expect.objectContaining({ description: expect.any(String) }),
    );

    // 6 histograms
    expect(fakeMeter.createHistogram).toHaveBeenCalledTimes(6);
    expect(fakeMeter.createHistogram).toHaveBeenCalledWith(
      "imessage.message.send_duration",
      expect.objectContaining({ unit: "ms" }),
    );
    expect(fakeMeter.createHistogram).toHaveBeenCalledWith(
      "imessage.message.receive_to_process_duration",
      expect.objectContaining({ unit: "ms" }),
    );
    expect(fakeMeter.createHistogram).toHaveBeenCalledWith(
      "imessage.gateway.session_duration",
      expect.objectContaining({ unit: "ms" }),
    );
    expect(fakeMeter.createHistogram).toHaveBeenCalledWith(
      "imessage.gateway.connect_duration",
      expect.objectContaining({ unit: "ms" }),
    );
    expect(fakeMeter.createHistogram).toHaveBeenCalledWith(
      "imessage.attachment.upload_duration",
      expect.objectContaining({ unit: "ms" }),
    );
    expect(fakeMeter.createHistogram).toHaveBeenCalledWith(
      "imessage.fetch.duration",
      expect.objectContaining({ unit: "ms" }),
    );

    // 1 upDownCounter
    expect(fakeMeter.createUpDownCounter).toHaveBeenCalledTimes(1);
    expect(fakeMeter.createUpDownCounter).toHaveBeenCalledWith(
      "imessage.gateway.active_listeners",
      expect.objectContaining({ description: expect.any(String) }),
    );

    // Verify fields are assigned
    expect(m.messagesReceived).toBe(stubCounter);
    expect(m.fetchDuration).toBe(stubHistogram);
    expect(m.activeGatewayListeners).toBe(stubUpDownCounter);
  });
});

describe("NOOP_METRICS", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("does not touch the global meter provider when imported", async () => {
    const getMeterProviderSpy = vi.spyOn(metrics, "getMeterProvider");

    const { NOOP_METRICS } = await import("./metrics");
    NOOP_METRICS.messagesSent.add(1, { mode: "local" });
    NOOP_METRICS.fetchDuration.record(5, { mode: "local" });
    NOOP_METRICS.activeGatewayListeners.add(1);

    expect(getMeterProviderSpy).not.toHaveBeenCalled();
  });

  it("is an instance of AdapterMetrics (prototype check)", async () => {
    const { NOOP_METRICS, AdapterMetrics } = await import("./metrics");
    expect(NOOP_METRICS).toBeInstanceOf(AdapterMetrics);
  });

  it("all counter fields are callable without throwing", async () => {
    const { NOOP_METRICS } = await import("./metrics");

    const counters = [
      NOOP_METRICS.messagesReceived,
      NOOP_METRICS.messagesSent,
      NOOP_METRICS.messageSendErrors,
      NOOP_METRICS.gatewaySessions,
      NOOP_METRICS.gatewayErrors,
      NOOP_METRICS.reactionsSent,
      NOOP_METRICS.pollsCreated,
      NOOP_METRICS.pollVotesReceived,
      NOOP_METRICS.pollVotesDropped,
      NOOP_METRICS.attachmentsSent,
      NOOP_METRICS.initErrors,
    ];
    for (const c of counters) {
      expect(() => c.add(1)).not.toThrow();
    }
  });

  it("all histogram fields are callable without throwing", async () => {
    const { NOOP_METRICS } = await import("./metrics");

    const histograms = [
      NOOP_METRICS.messageSendDuration,
      NOOP_METRICS.messageReceiveToProcessDuration,
      NOOP_METRICS.gatewaySessionDuration,
      NOOP_METRICS.gatewayConnectDuration,
      NOOP_METRICS.attachmentUploadDuration,
      NOOP_METRICS.fetchDuration,
    ];
    for (const h of histograms) {
      expect(() => h.record(42)).not.toThrow();
    }
  });

  it("activeGatewayListeners upDownCounter is callable without throwing", async () => {
    const { NOOP_METRICS } = await import("./metrics");
    expect(() => NOOP_METRICS.activeGatewayListeners.add(1)).not.toThrow();
    expect(() => NOOP_METRICS.activeGatewayListeners.add(-1)).not.toThrow();
  });
});
