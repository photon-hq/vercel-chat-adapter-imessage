/**
 * OTel SDK registration — loaded via `node --import ./register.js`
 *
 * This configures the SDK providers BEFORE the adapter is imported,
 * ensuring the global providers are set up when the adapter reads them.
 *
 * Sends all 3 signals (traces, metrics, logs) to the OTLP gRPC endpoint.
 * Default: localhost:4317 (override with OTEL_EXPORTER_OTLP_ENDPOINT).
 */

import traceExporterPkg from "@opentelemetry/exporter-trace-otlp-grpc";
const { OTLPTraceExporter } = traceExporterPkg;
import metricExporterPkg from "@opentelemetry/exporter-metrics-otlp-grpc";
const { OTLPMetricExporter } = metricExporterPkg;
import logExporterPkg from "@opentelemetry/exporter-logs-otlp-grpc";
const { OTLPLogExporter } = logExporterPkg;
import sdkNodePkg from "@opentelemetry/sdk-node";
const { NodeSDK } = sdkNodePkg;
import sdkMetricsPkg from "@opentelemetry/sdk-metrics";
const { PeriodicExportingMetricReader } = sdkMetricsPkg;
import sdkLogsPkg from "@opentelemetry/sdk-logs";
const { BatchLogRecordProcessor } = sdkLogsPkg;
import resourcesPkg from "@opentelemetry/resources";
const { resourceFromAttributes } = resourcesPkg;

const endpoint =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4317";

const resource = resourceFromAttributes({
  "service.name": process.env.OTEL_SERVICE_NAME || "imessage-demo",
  "service.version": "0.1.1",
});

const sdk = new NodeSDK({
  resource,
  traceExporter: new OTLPTraceExporter({ url: endpoint }),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({ url: endpoint }),
    exportIntervalMillis: 5000,
  }),
  logRecordProcessors: [
    new BatchLogRecordProcessor(new OTLPLogExporter({ url: endpoint })),
  ],
});

sdk.start();
console.log(`[otel] SDK started — exporting to ${endpoint}`);

// Graceful shutdown
const shutdown = async () => {
  console.log("[otel] Shutting down SDK...");
  await sdk.shutdown();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
