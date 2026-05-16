/**
 * Shared OpenTelemetry tracer + helpers for the Next side.
 *
 * Why a helper module:
 *  - One canonical instrumentation-library name ("interview-assistant").
 *    Every span this app emits shares the same `instrumentation.scope`
 *    so they are easy to filter for in Honeycomb / Tempo / Jaeger.
 *  - Centralised `traced(...)` wrapper records exceptions + sets span
 *    status without every call-site repeating the try/finally boilerplate.
 *  - `currentTraceparent()` returns the W3C traceparent string for the
 *    active span; we stuff this into LiveKit room metadata so the
 *    Python agent can extract it and continue the same trace.
 */

import { trace, context, SpanStatusCode, type Span } from "@opentelemetry/api";

const TRACER_NAME = "interview-assistant";

export const tracer = trace.getTracer(TRACER_NAME);

/**
 * Open a span, run `fn` inside it, record any thrown exception, and end
 * the span on the way out. The span is parented at whatever the current
 * OTel context is — so when used inside another `traced()` block, you
 * get a properly nested call tree.
 */
export async function traced<T>(
  name: string,
  attributes: Record<string, string | number | boolean | undefined>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    // OTel rejects `undefined`-valued attributes — filter them out so
    // call-sites can pass optional fields without checking each one.
    for (const [k, v] of Object.entries(attributes)) {
      if (v !== undefined) span.setAttribute(k, v);
    }
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: (err as Error).message,
      });
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Return the W3C `traceparent` string for the currently active span,
 * or null if no span is active. Used to inject the trace context into
 * LiveKit room metadata so the Python agent can join the same trace.
 *
 * traceparent format: 00-{trace_id}-{span_id}-{trace_flags}
 *   - version (00)
 *   - trace_id (32 hex chars)
 *   - parent span_id (16 hex chars)
 *   - trace_flags (01 = sampled)
 */
export function currentTraceparent(): string | null {
  const span = trace.getSpan(context.active());
  if (!span) return null;
  const ctx = span.spanContext();
  if (!ctx.traceId || !ctx.spanId) return null;
  const flags = ctx.traceFlags.toString(16).padStart(2, "0");
  return `00-${ctx.traceId}-${ctx.spanId}-${flags}`;
}
