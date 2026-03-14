import type { Logger } from "chat";
import { trace, context } from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import type { LoggerProvider } from "@opentelemetry/api-logs";
import { LIBRARY_NAME, LIBRARY_VERSION } from "./config.js";

export class OTelLogger implements Logger {
  private readonly delegate: Logger;
  private readonly provider: LoggerProvider;
  private readonly otelLogger: ReturnType<LoggerProvider["getLogger"]>;
  private readonly name: string;
  private readonly baseAttributes: Record<string, string | number | boolean>;

  constructor(
    delegate: Logger,
    provider?: LoggerProvider,
    name?: string,
    baseAttributes?: Record<string, string | number | boolean>,
  ) {
    this.delegate = delegate;
    this.name = name ?? LIBRARY_NAME;
    this.provider = provider ?? logs.getLoggerProvider();
    this.baseAttributes = baseAttributes ?? {};
    this.otelLogger = this.provider.getLogger(this.name, LIBRARY_VERSION);
  }

  info(message: string, metadata?: object): void {
    this.delegate.info(message, metadata);
    this.emitLogRecord(SeverityNumber.INFO, "INFO", message, metadata);
  }

  warn(message: string, metadata?: object): void {
    this.delegate.warn(message, metadata);
    this.emitLogRecord(SeverityNumber.WARN, "WARN", message, metadata);
  }

  error(message: string, metadata?: object): void {
    this.delegate.error(message, metadata);
    this.emitLogRecord(SeverityNumber.ERROR, "ERROR", message, metadata);
  }

  debug(message: string, metadata?: object): void {
    this.delegate.debug(message, metadata);
    this.emitLogRecord(SeverityNumber.DEBUG, "DEBUG", message, metadata);
  }

  child(name: string): Logger {
    return new OTelLogger(
      this.delegate.child(name),
      this.provider,
      `${this.name}.${name}`,
      this.baseAttributes,
    );
  }

  private emitLogRecord(
    severityNumber: SeverityNumber,
    severityText: string,
    message: string,
    metadata?: object,
  ): void {
    try {
      // Get current trace context for correlation
      const activeContext = context.active();
      const attributes = {
        ...this.baseAttributes,
        ...(metadata ? this.flattenMetadata(metadata) : {}),
      };

      this.otelLogger.emit({
        severityNumber,
        severityText,
        body: message,
        attributes:
          Object.keys(attributes).length > 0 ? attributes : undefined,
        context: activeContext,
      });
    } catch {
      // Telemetry emission failure — never propagate to business logic
    }
  }

  private flattenMetadata(
    metadata: object,
  ): Record<string, string | number | boolean> {
    const result: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(metadata)) {
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        result[key] = value;
      } else {
        result[key] = String(value);
      }
    }
    return result;
  }
}
