import type { TracerProvider, MeterProvider } from "@opentelemetry/api";
import type { LoggerProvider } from "@opentelemetry/api-logs";

/** Instrumentation library identity */
export const LIBRARY_NAME = "chat-adapter-imessage";

/** Instrumentation library version — keep in sync with package.json */
export const LIBRARY_VERSION = "0.1.1";

/**
 * Configuration for OpenTelemetry instrumentation of the iMessage adapter.
 *
 * This is a library — the consumer owns the providers. All provider fields are
 * optional; when omitted the global provider registered via `@opentelemetry/api`
 * is used instead.
 */
export interface iMessageOTelConfig {
  /** Enable OTel instrumentation. Default: false */
  enabled: boolean;

  /** TracerProvider to use. If not provided, uses global. */
  tracerProvider?: TracerProvider;

  /** MeterProvider to use. If not provided, uses global. */
  meterProvider?: MeterProvider;

  /** LoggerProvider to use. If not provided, uses global. */
  loggerProvider?: LoggerProvider;

  /** Optional service name attribute attached to emitted telemetry. */
  serviceName?: string;

  /** Redact PII (phone numbers) from span attributes. Default: true */
  redactPII?: boolean;
}

/** Sensible defaults — instrumentation is opt-in and PII is redacted. */
export const DEFAULT_OTEL_CONFIG: iMessageOTelConfig = {
  enabled: false,
  redactPII: true,
};
