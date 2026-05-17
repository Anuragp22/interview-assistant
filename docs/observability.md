# Observability

End-to-end OpenTelemetry tracing across the practice-session flow:
**Next.js** server actions → **Firestore** (carries the trace) → **LiveKit**
room → **Python agent** + LLM/STT/TTS calls. Two of those are OTel-instrumented
processes we own and emit spans (Next.js and the Python agent); Firestore is
the carrier (a W3C `traceparent` field rides on the session doc and is
rehydrated by the agent on entry); LiveKit is the transport (it dispatches
the agent into the room). One trace ID covers the whole flow in Honeycomb /
Grafana Tempo / Jaeger.

## Why this exists

LLM apps without traces are unsupportable in production. The grounding
silently-broken-bug we caught with the eval harness (Llama returning
`"high"/"medium"/"low"` for `depth`) was visible from above in less than a
minute — but it took an offline eval run to find it. Traces give the same
visibility live: which phase took 8 seconds, which `verify_cv_claim` came
back `unsupported`, which Groq call retried, where the user-perceived
latency went.

The harness covers the question-generation pipeline once a session is
created. Tracing covers everything that happens after — the interview
itself, where the harness can't reach.

## Trace shape

```
GET /practice/new            (auto, from Next.js)
└─ practice.create-session   (lib/actions/practice.action.ts)
   ├─ phase1.generate-template
   │  └─ ai.generateObject.doGenerate     (AI SDK telemetry)
   │     - gen_ai.system=groq
   │     - gen_ai.request.model=llama-3.3-70b-versatile
   │     - gen_ai.usage.input_tokens, gen_ai.usage.output_tokens
   ├─ firestore.template.write
   ├─ phase2.reground-against-cv
   │  └─ ai.generateObject.doGenerate
   └─ firestore.session.write
      [traceparent stored on session doc]

  ─── process boundary (LiveKit room dispatch) ───

agent.panel-session          (livekit-agent/src/interview_agent/agent.py)
- session.id, candidate.uid, interview.role, interview.level
- trace.propagated=true   ← link to the Next side
├─ rag.build-index         (LlamaIndex / fastembed)
├─ agent.on-enter          persona.id=behavioral
├─ agent.tool.lookup_cv_jd persona.id=behavioral, rag.query="..."
├─ agent.tool.verify_cv_claim
│   ├─ rag.verify-claim    verdict=supported|ambiguous|unsupported, similarity=0.62
├─ agent.transfer          from.persona=behavioral, to.persona=technical
├─ agent.on-enter          persona.id=technical
├─ ... (technical round)
├─ agent.transfer          from.persona=technical, to.persona=system-design
├─ agent.on-enter          persona.id=system-design
├─ ... (system-design round)
└─ agent.end-interview     persona.id=system-design
```

Each layer's tracing is opt-in via env vars — leave them unset and the
service runs unchanged with the SDK's built-in console exporter dumping
spans to stdout.

## Backend setup (Honeycomb is the recommended default)

Honeycomb's free tier gives 20M events/month and the best UX for a small
demo. Substitute any OTLP/HTTP backend by changing the endpoint and
dropping the Honeycomb-specific headers.

```bash
# .env.local
OTEL_EXPORTER_OTLP_ENDPOINT=https://api.honeycomb.io/v1/traces
HONEYCOMB_API_KEY=<your-key>
HONEYCOMB_DATASET=interview-assistant
```

The agent picks up the same vars from `.env.local` via `_load_env()` in
`livekit-agent/src/interview_agent/agent.py`. No separate config.

Grafana Cloud Tempo:
```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://tempo-prod-XX-prod-XX.grafana.net/otlp/v1/traces
# Tempo auth is Basic — pass via OTEL_EXPORTER_OTLP_HEADERS
```

Self-hosted Jaeger / OpenTelemetry Collector: point at `http://otel-collector:4318/v1/traces`.

## Local dev (no signup required)

Leave `OTEL_EXPORTER_OTLP_ENDPOINT` unset. Both Next.js and the agent fall
back to `ConsoleSpanExporter`, which dumps each span as JSON to stdout.

A single `GET /practice` boots the SDK and produces output like:

```
{
  resource: { attributes: { 'service.name': 'interview-assistant-web', ... } },
  instrumentationScope: { name: 'next.js', ... },
  traceId: '1296d193e31fb8c84be39174b520463b',
  parentSpanContext: { spanId: '4ed7c8f495a157c2', ... },
  name: 'render route (app) /practice',
  duration: 482606.3,
  status: { code: 0 },
  ...
}
```

Useful for verifying the span tree is right before pointing a real backend
at it.

## How the cross-process propagation works

1. The Next.js server action `createPracticeSession` opens a root span
   `practice.create-session`. Before writing the session doc, it grabs
   the current span's W3C traceparent via `currentTraceparent()`
   (`lib/tracing.ts`).
2. The traceparent string (`00-{trace_id}-{span_id}-01`) goes on the
   session document as `session.traceparent`.
3. When LiveKit dispatches the agent into the room `session-{id}`, the
   agent's `entrypoint()` (`livekit-agent/src/interview_agent/agent.py`)
   loads `SessionData`, extracting the traceparent.
4. `context_from_traceparent()` calls `opentelemetry.propagate.extract()`
   to rehydrate the OTel `Context`. Every span opened inside the agent's
   `agent.panel-session` block becomes a descendant of the Next-side
   root span — they share `trace_id`, and the agent's root span gets the
   Next span as its parent.
5. ContextVars propagate the active span through asyncio tasks, so
   `on_enter`, `transfer_to_*`, tool calls, and RAG operations all nest
   correctly without manual context plumbing.

If the traceparent is absent (legacy session created before OTel was
wired up), the agent opens a fresh root trace instead. The
`trace.propagated=false` attribute on the agent's root span makes those
cases easy to filter for.

## What's instrumented

| Layer | Spans | Notes |
|---|---|---|
| Next.js auto | `GET /practice`, `render route`, `build component tree`, `resolve segment modules`, ... | Free from `@vercel/otel` — every server-side request gets a span tree |
| Server actions | `practice.create-session`, `phase1.generate-template`, `phase2.reground-against-cv`, `firestore.template.write`, `firestore.session.write` | Wrapped via `traced()` in `lib/tracing.ts` |
| AI SDK Groq calls | `ai.generateObject.doGenerate` with `gen_ai.*` attributes (model, tokens, finish reasons) | `experimental_telemetry: { isEnabled: true }` on each call |
| Python agent runtime | `agent.panel-session`, `agent.on-enter`, `agent.transfer`, `agent.end-interview`, `agent.tool.lookup_cv_jd`, `agent.tool.verify_cv_claim` | Manual spans in `agent.py` |
| RAG | `rag.build-index`, `rag.query`, `rag.verify-claim` (with verdict + similarity) | Manual spans in `rag.py` |

The interesting attributes on each span are deliberately small (no raw
CV text, no full claim) so traces stay inexpensive and don't leak PII to
the tracing backend.

## What's NOT instrumented (yet)

- HR-mode routes — dormant by design, will add when they come back.
- Browser-side spans — `@vercel/otel` is server-side only. Adding a
  browser SDK would let us trace the user's "Start Interview" click
  → `practice.create-session`, but that's a separate workstream.
- ElevenLabs / Deepgram HTTP calls — `livekit-agents` issues these via
  its own HTTP clients; full instrumentation needs `opentelemetry-
  instrumentation-httpx` or `-requests`. Out of scope for v1; the
  per-tool spans already show the work that matters.
- Metrics (counters / histograms). Span attributes carry enough data
  for the v1 dashboards.

## Verifying the propagation contract

`livekit-agent/tests/test_tracing.py` has 5 tests covering:

- `context_from_traceparent(None)` and empty string both return `None`
- Valid traceparent yields a usable `Context`
- `install_tracer_provider()` is idempotent (LiveKit re-runs `prewarm`
  across workers)
- A span opened under a propagated context inherits the exact trace_id
  encoded in the parent traceparent
- A span opened with no propagated context starts a fresh root trace

The 4th test is the load-bearing one — if it ever fails, distributed
traces are broken end-to-end.

## Latency budget

Every assistant turn emits an `agent.turn-latency` span with four
deterministic timing legs and a budget verdict. Budgets are p95
targets, not averages — tail latency drives the perceived feel of a
voice interview far more than mean.

| Stage    | p95 budget | Why |
|----------|-----------:|-----|
| EOU      |     300 ms | STT commit overhead after speech ends. The 800ms `min_delay` is wait time, not commit time. |
| LLM TTFT |     500 ms | Groq llama-3.3-70b first-token. Groq publishes 80-150 ms warm; we budget 500 to absorb cold-connect and retry. |
| TTS TTFB |     500 ms | ElevenLabs `eleven_turbo_v2_5` over multi-stream WebSocket with `streaming_latency=3`. ElevenLabs SLO is ~200 ms. |
| E2E turn |    1500 ms | User-stops-speaking → user-hears-first-audio. Above 2s users start repeating themselves. |

Source of truth: `livekit-agent/src/interview_agent/latency_budget.py`.
The replay analyzer (`eval/latency-report.ts`) hard-codes the same
thresholds — keep them in sync if you tighten.

**Streaming path:** `livekit-plugins-elevenlabs` already uses the
WebSocket multi-stream-input endpoint by default (verified by
inspecting `livekit/plugins/elevenlabs/tts.py`). We opt into
`streaming_latency=3` in `_build_tts_for` (`agent.py`) for the
"max latency optimization" profile without disabling text
normalization (4 disables normalization and risks mispronouncing
numbers/abbreviations).

## Capturing a session for the replay analyzer

The Python tracing module supports an optional `OTEL_TRACES_FILE` env
var. When set, every span the agent emits is written as a one-per-line
JSON object to that file, in addition to whatever primary exporter is
configured (console / Honeycomb / Tempo).

```bash
# Inside the agent process env (e.g., .env.local at the repo root)
OTEL_TRACES_FILE=eval/sessions/2026-05-16-mvp.spans.jsonl
```

Run a session normally, then point the analyzer at the file:

```bash
npm run latency-report -- eval/sessions/2026-05-16-mvp.spans.jsonl

# Exit non-zero if any p95 leg exceeds its budget (useful from CI):
npm run latency-report -- eval/sessions/2026-05-16-mvp.spans.jsonl --strict
```

The analyzer ignores non-`agent.turn-latency` spans, so capturing
everything is fine — no need to filter the JSONL first.

Output (sample, real numbers depend on your session):

```
## Latency (10 turns from .../session.spans.jsonl)

| Stage    |   p50 |   p95 |   p99 | Budget | Status |
|----------|-------|-------|-------|--------|--------|
| EOU      |   208 |   251 |   258 |    300 |  OK    |
| LLM TTFT |   290 |   453 |   475 |    500 |  OK    |
| TTS TTFB |   313 |   407 |   426 |    500 |  OK    |
| E2E      |   800 |  1111 |  1158 |   1500 |  OK    |
```

Captured session JSONLs live under `eval/sessions/` and are gitignored
— commit only sanitised numbers, not raw transcripts.

## Cost telemetry

Every session writes an estimated dollar cost broken down by provider.
Sources of truth: `lib/cost-rates.ts` (TypeScript) and
`livekit-agent/src/interview_agent/cost_rates.py` (Python mirror). Both
files carry `RATES_SOURCED_AT = "YYYY-MM-DD"` — bump in both whenever
you refresh prices.

Current rates (as of `RATES_SOURCED_AT`):

| Provider     | Model                   | Pricing dimension     | Rate                            |
|--------------|-------------------------|-----------------------|---------------------------------|
| Groq         | llama-3.3-70b-versatile | Input / output tokens | $0.59 / 1M in, $0.79 / 1M out   |
| ElevenLabs   | eleven_turbo_v2_5       | Characters synthesized| $0.18 / 1k chars (Creator tier) |
| Deepgram     | nova-3                  | Audio minutes         | $0.0058 / minute streaming      |
| LiveKit      | Cloud Build             | Participant-minutes   | $0.005 × 2 participants         |

**How it flows:**

1. Python agent subscribes to `session_usage_updated` (SDK-recommended;
   the older `metrics_collected` event is deprecated for usage
   tracking). `SessionCostAggregator` keeps the latest cumulative
   counts from each `model_usage` entry.
2. On session end the aggregator's `finalize()` rolls counts through
   the price registry into a `CostBreakdown`, writes
   `sessions/{id}.estimatedCost` to Firestore (camelCase keys matching
   the TS type), and emits a `session.cost` OTel span carrying every
   leg.
3. The practice dashboard reads `Session.estimatedCost` and renders
   `$0.14` per row plus a cumulative-cost card across sessions.

**Disclaimer:** this is an estimate. Subscription plans, free tiers,
volume discounts, and regional pricing all change the real bill. The
date stamp on `RATES_SOURCED_AT` is your signal to revisit.

**Offline analyzer (`npm run latency-report`):** the replay tool now
ingests `session.cost` spans alongside `agent.turn-latency` and emits
a per-leg p50/p95/p99 cost table plus a cumulative total. Sample:

```
## Cost (3 sessions)

| Leg       |    p50 |    p95 |    p99 |
|-----------|--------|--------|--------|
| Groq      |  $0.012 |  $0.017 |  $0.018 |
| TTS       |  $0.087 |  $0.101 |  $0.103 |
| STT       |  $0.004 |  $0.005 |  $0.005 |
| LiveKit   |  $0.018 |  $0.023 |  $0.024 |
| **Total** |  $0.121 |  $0.147 |  $0.149 |

Cumulative across all sessions: $0.367.
```

## Files

```
instrumentation.ts                          Next.js OTel bootstrap (registerOTel)
lib/tracing.ts                              traced() helper + currentTraceparent()
lib/cost-rates.ts                           TS price registry + rollUpCost()
livekit-agent/src/interview_agent/
  tracing.py                                Python OTel bootstrap + JSONLSpanExporter
  latency_budget.py                         Per-stage p95 thresholds + violated()
  metrics_bridge.py                         MetricsReport → agent.turn-latency span
  cost_rates.py                             Python price mirror + roll_up_cost()
  cost_aggregator.py                        SessionCostAggregator (session.cost span + Firestore write)
livekit-agent/tests/
  test_tracing.py                           5 propagation-contract tests
  test_latency.py                           8 budget + bridge tests
  test_cost.py                              10 cost-rate + aggregator tests
tests/cost-rates.test.ts                    12 TS cost-rate tests
eval/latency-report.ts                      Offline percentile analyzer (latency + cost)
docs/observability.md                       (this file)
```
