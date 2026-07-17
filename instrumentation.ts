/**
 * Next.js OpenTelemetry bootstrap.
 *
 * Next.js calls `register()` once per server start. We wire up
 * @vercel/otel here so every server-action / route-handler / fetch
 * call gets traced automatically, and so custom spans we open via
 * `trace.getTracer("...").startActiveSpan(...)` get exported too.
 *
 * Exporter selection — mirrors the agent side
 * (livekit-agent/src/interview_agent/tracing.py::_resolve_otlp_config):
 *   - If OTEL_EXPORTER_OTLP_ENDPOINT is set, we ship spans to that
 *     OTLP/HTTP+JSON endpoint. For Honeycomb the endpoint is
 *     https://api.honeycomb.io/v1/traces and the API key goes in the
 *     X-Honeycomb-Team header. For Grafana Tempo, point at your tempo
 *     gateway. An explicit endpoint always wins — it's a deliberate
 *     operator decision, so Langfuse keys in the same env can't hijack it.
 *   - Else, if LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY are both set,
 *     we ship to Langfuse's OTLP endpoint (Basic auth over the key
 *     pair). The zero-config path: paste two keys, get traces.
 *   - If neither, we keep a ConsoleSpanExporter so local `npm run dev`
 *     dumps spans to stdout without any signup. Good for first-touch
 *     verification of trace propagation; useless in production.
 */

import { registerOTel, OTLPHttpJsonTraceExporter } from "@vercel/otel";
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

/** Langfuse Cloud EU. LANGFUSE_HOST switches region (us./jp./hipaa.) or
 * points at a self-hosted instance. */
const LANGFUSE_DEFAULT_HOST = "https://cloud.langfuse.com";

export function register(): void {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const honeycombKey = process.env.HONEYCOMB_API_KEY;
  const honeycombDataset = process.env.HONEYCOMB_DATASET ?? "interview-assistant";
  const langfusePk = process.env.LANGFUSE_PUBLIC_KEY;
  const langfuseSk = process.env.LANGFUSE_SECRET_KEY;

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
  } else if (langfusePk && langfuseSk) {
    // BOTH keys required: half a credential would 401 on every export
    // for the life of the process, and a batch exporter fails quietly.
    // `||`, not `??`: LANGFUSE_HOST= in a .env file loads as an empty
    // string, and an empty host would build a relative `/api/...` URL
    // that only fails once spans start exporting.
    const host = (process.env.LANGFUSE_HOST || LANGFUSE_DEFAULT_HOST).replace(
      /\/$/,
      "",
    );
    spanProcessors.push(
      new BatchSpanProcessor(
        new OTLPHttpJsonTraceExporter({
          url: `${host}/api/public/otel/v1/traces`,
          headers: {
            Authorization: `Basic ${Buffer.from(`${langfusePk}:${langfuseSk}`).toString("base64")}`,
            // Opts into Langfuse Cloud's real-time ingestion. Optional
            // per their docs; without it traces lag behind the session.
            "x-langfuse-ingestion-version": "4",
          },
        }),
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
