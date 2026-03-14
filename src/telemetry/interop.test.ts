import { describe, it, expect, afterEach } from "vitest";
import { trace, metrics } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { MetricReader, MeterProvider } from "@opentelemetry/sdk-metrics";
import { createTracer, withSpan } from "./tracer";
import { AdapterMetrics, createMeter, NOOP_METRICS } from "./metrics";

/** In-memory metric reader for testing (TestMetricReader was removed in sdk-metrics v2) */
class InMemoryMetricReader extends MetricReader {
  protected override onForceFlush(): Promise<void> {
    return Promise.resolve();
  }
  protected override onShutdown(): Promise<void> {
    return Promise.resolve();
  }
}

describe("provider interop — real SDK", () => {
  let spanExporter: InMemorySpanExporter;
  let tracerProvider: NodeTracerProvider;
  let metricReader: InMemoryMetricReader;
  let meterProvider: MeterProvider;

  function setup() {
    spanExporter = new InMemorySpanExporter();
    tracerProvider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(spanExporter)],
    });

    metricReader = new InMemoryMetricReader();
    meterProvider = new MeterProvider({ readers: [metricReader] });
  }

  afterEach(async () => {
    if (tracerProvider) await tracerProvider.shutdown().catch(() => {});
    if (meterProvider) await meterProvider.shutdown().catch(() => {});
    if (spanExporter) spanExporter.reset();
    trace.disable();
    metrics.disable();
  });

  it("creates real spans via createTracer + withSpan", async () => {
    setup();
    const tracer = createTracer(tracerProvider);
    const result = await withSpan(tracer, "test.operation", { "test.attr": "value" }, async () => {
      return "result";
    });

    expect(result).toBe("result");
    const spans = spanExporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe("test.operation");
    expect(spans[0].attributes["test.attr"]).toBe("value");
  });

  it("records error spans with real SDK", async () => {
    setup();
    const tracer = createTracer(tracerProvider);

    await expect(
      withSpan(tracer, "test.failing", {}, async () => {
        throw new Error("test failure");
      })
    ).rejects.toThrow("test failure");

    const spans = spanExporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].status.code).toBe(2); // SpanStatusCode.ERROR
    expect(spans[0].events.length).toBeGreaterThan(0);
    expect(spans[0].events[0].name).toBe("exception");
  });

  it("null tracer produces zero spans even with real global provider", async () => {
    setup();
    trace.setGlobalTracerProvider(tracerProvider);

    const result = await withSpan(null, "should.not.appear", {}, async () => "ok");

    expect(result).toBe("ok");
    const spans = spanExporter.getFinishedSpans();
    expect(spans).toHaveLength(0);
  });

  it("NOOP_METRICS produces zero data points even with real global MeterProvider", async () => {
    setup();
    metrics.setGlobalMeterProvider(meterProvider);

    NOOP_METRICS.messagesSent.add(1, { mode: "remote" });
    NOOP_METRICS.messageSendDuration.record(150, { mode: "remote" });
    NOOP_METRICS.activeGatewayListeners.add(1);

    const { resourceMetrics } = await metricReader.collect();
    const dataPoints = resourceMetrics.scopeMetrics
      .flatMap((sm) => sm.metrics)
      .flatMap((m) => m.dataPoints as any[]);

    expect(dataPoints).toHaveLength(0);
  });

  it("creates real metrics via createMeter + AdapterMetrics", async () => {
    setup();
    const meter = createMeter(meterProvider);
    const m = new AdapterMetrics(meter);

    m.messagesSent.add(1, { mode: "remote" });
    m.messageSendDuration.record(150, { mode: "remote" });
    m.activeGatewayListeners.add(1);

    const { resourceMetrics } = await metricReader.collect();
    const allMetrics = resourceMetrics.scopeMetrics.flatMap((sm) => sm.metrics);

    expect(allMetrics.length).toBeGreaterThan(0);
    const metricNames = allMetrics.map((m) => m.descriptor.name);
    expect(metricNames).toContain("imessage.messages.sent");
    expect(metricNames).toContain("imessage.message.send_duration");
    expect(metricNames).toContain("imessage.gateway.active_listeners");
  });

  it("forceFlush works on real provider without error", async () => {
    setup();
    await expect(tracerProvider.forceFlush()).resolves.toBeUndefined();
    await expect(meterProvider.forceFlush()).resolves.toBeUndefined();
  });
});
