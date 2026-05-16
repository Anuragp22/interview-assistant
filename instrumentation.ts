/**
 * Next.js OpenTelemetry bootstrap.
 *
 * Next.js calls `register()` once per server start. We wire up
 * @vercel/otel here so every server-action / route-handler / fetch
 * call gets traced automatically, and so custom spans we open via
 * `trace.getTracer("...").startActiveSpan(...)` get exported too.
 *
 * Exporter selection:
 *   - If OTEL_EXPORTER_OTLP_ENDPOINT is set, we ship spans to that
 *     OTLP/HTTP+JSON endpoint. For Honeycomb the endpoint is
 *     https://api.honeycomb.io/v1/traces and the API key goes in the
 *     X-Honeycomb-Team header. For Grafana Tempo, point at your tempo
 *     gateway.
 *   - If not set, we keep a ConsoleSpanExporter so local `npm run dev`
 *     dumps spans to stdout without any signup. Good for first-touch
 *     verification of trace propagation; useless in production.
 */

import { registerOTel, OTLPHttpJsonTraceExporter } from "@vercel/otel";
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

export function register(): void {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const honeycombKey = process.env.HONEYCOMB_API_KEY;
  const honeycombDataset = process.env.HONEYCOMB_DATASET ?? "interview-assistant";

  const spanProcessors = [];

  if (endpoint) {
    // Honeycomb's free tier accepts OTLP/HTTP+JSON at
    // https://api.honeycomb.io/v1/traces. Other backends (Grafana
    // Tempo, Jaeger, an OTel collector) plug in the same way — just
    // set the env var.
    const headers: Record<string, string> = {};
    if (honeycombKey) {
      headers["X-Honeycomb-Team"] = honeycombKey;
      headers["X-Honeycomb-Dataset"] = honeycombDataset;
    }
    spanProcessors.push(
      new BatchSpanProcessor(
        new OTLPHttpJsonTraceExporter({ url: endpoint, headers }),
      ),
    );
  } else {
    // Local dev fallback. SimpleSpanProcessor flushes immediately so
    // you see spans in the terminal turn by turn instead of buffered.
    spanProcessors.push(new SimpleSpanProcessor(new ConsoleSpanExporter()));
  }

  registerOTel({
    serviceName: "interview-assistant-web",
    spanProcessors,
    instrumentationConfig: {
      fetch: {
        // The agent process talks to LiveKit, Groq, ElevenLabs over its
        // own HTTP clients — we don't need this Next-side fetch
        // instrumentation to propagate W3C headers to those URLs. We
        // DO propagate to Firebase and LiveKit token-server URLs so
        // their spans nest under ours when those services emit them.
        propagateContextUrls: [
          /^https:\/\/firestore\.googleapis\.com/,
          /^https:\/\/.*\.firebaseio\.com/,
          /^https:\/\/.*\.livekit\.cloud/,
        ],
        ignoreUrls: [
          // Next's own telemetry pings — never useful in a trace.
          /^https:\/\/telemetry\.nextjs\.org/,
        ],
      },
    },
  });
}
