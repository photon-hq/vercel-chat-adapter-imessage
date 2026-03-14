import {
  INVALID_SPAN_CONTEXT,
  trace,
  SpanStatusCode,
  type Span,
  type Tracer,
  type Attributes,
  type SpanKind,
  type TracerProvider,
} from "@opentelemetry/api";

import { LIBRARY_NAME, LIBRARY_VERSION } from "./config.js";

const NON_RECORDING_SPAN = trace.wrapSpanContext(INVALID_SPAN_CONTEXT);

/**
 * Get or create a tracer from a TracerProvider (or the global provider).
 */
export function createTracer(provider?: TracerProvider): Tracer {
  const tp = provider ?? trace.getTracerProvider();
  return tp.getTracer(LIBRARY_NAME, LIBRARY_VERSION);
}

/**
 * Execute an async function within a new span.
 * Records exceptions and sets error status on failure.
 * No-op wrapper when tracer is null (OTel disabled).
 */
export async function withSpan<T>(
  tracer: Tracer | null,
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
  kind?: SpanKind,
): Promise<T> {
  if (!tracer) {
    return await fn(NON_RECORDING_SPAN);
  }

  return tracer.startActiveSpan(
    name,
    { attributes, kind },
    async (span) => {
      try {
        const result = await fn(span);
        try {
          span.setStatus({ code: SpanStatusCode.OK });
        } catch {
          // Span lifecycle errors must not disrupt the caller
        }
        return result;
      } catch (error) {
        try {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : String(error),
          });
        } catch {
          // Span lifecycle errors must not disrupt the caller
        }
        try {
          span.recordException(
            error instanceof Error ? error : new Error(String(error)),
          );
        } catch {
          // Span lifecycle errors must not disrupt the caller
        }
        throw error;
      } finally {
        try {
          span.end();
        } catch {
          // Span lifecycle errors must not disrupt the caller
        }
      }
    },
  );
}

/**
 * Execute a synchronous function within a new span.
 * Records exceptions and sets error status on failure.
 * No-op wrapper when tracer is null (OTel disabled).
 */
export function withSyncSpan<T>(
  tracer: Tracer | null,
  name: string,
  attributes: Attributes,
  fn: (span: Span) => T,
): T {
  if (!tracer) {
    return fn(NON_RECORDING_SPAN);
  }

  return tracer.startActiveSpan(name, { attributes }, (span) => {
    try {
      const result = fn(span);
      try {
        span.setStatus({ code: SpanStatusCode.OK });
      } catch {
        // Span lifecycle errors must not disrupt the caller
      }
      return result;
    } catch (error) {
      try {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });
      } catch {
        // Span lifecycle errors must not disrupt the caller
      }
      try {
        span.recordException(
          error instanceof Error ? error : new Error(String(error)),
        );
      } catch {
        // Span lifecycle errors must not disrupt the caller
      }
      throw error;
    } finally {
      try {
        span.end();
      } catch {
        // Span lifecycle errors must not disrupt the caller
      }
    }
  });
}
