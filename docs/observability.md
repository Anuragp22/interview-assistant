# Observability

End-to-end OpenTelemetry tracing across the practice-session flow:
**Next.js** server actions → **Firestore** (carries the trace) → **LiveKit**
room → **Python agent** + the voice pipeline. Two of those are OTel-instrumented
processes we own: the Next.js server (`instrumentation.ts`) and the Python agent
worker (`livekit-agent/src/interview_agent/tracing.py`). Firestore is the
carrier — a W3C `traceparent` field rides on the session doc and is rehydrated
by the agent on entry. LiveKit is the transport: it dispatches the agent into
the room. One trace ID covers the whole flow in Langfuse / Honeycomb / Grafana
Tempo / Jaeger — set two Langfuse keys and there is nothing else to configure
(see "Langfuse quickstart"), or leave everything unset and read the spans on
stdout.

## Why this exists

The eval harness (`eval/`) covers the question-generation pipeline up to the
point a session is created. Tracing covers everything after — the interview
itself, where the harness cannot reach. Which round took eight seconds, which
Groq call retried, where the user-perceived latency went, and what the session
cost: none of that is answerable from logs alone once the work is spread across
a Vercel function and a long-lived Python worker in another region.

## Architecture

| Side | Bootstrap | Exporter when a sink is configured | Exporter when nothing is set |
|---|---|---|---|
| Web | `instrumentation.ts` → `registerOTel()` from `@vercel/otel`, `serviceName: interview-assistant-web` | `BatchSpanProcessor` + `OTLPHttpJsonTraceExporter` (OTLP/**HTTP+JSON**) | `SimpleSpanProcessor` + `ConsoleSpanExporter` |
| Agent | `tracing.py` → `install_tracer_provider()`, `service.name: interview-assistant-agent` | `BatchSpanProcessor` + `OTLPSpanExporter` (OTLP/**HTTP+protobuf**) | `SimpleSpanProcessor` + `ConsoleSpanExporter` |

### Which sink, and why that order

Both sides resolve the sink from env with the same three-step priority. The
agent's copy is `_resolve_otlp_config()` (`tracing.py`) — a pure env-reader,
unit-tested exhaustively; the web side open-codes the same chain in
`register()` (`instrumentation.ts`).

1. **`OTEL_EXPORTER_OTLP_ENDPOINT`** — ships there, plus the optional Honeycomb
   headers (`HONEYCOMB_API_KEY` → `x-honeycomb-team`, `HONEYCOMB_DATASET` →
   `x-honeycomb-dataset`, defaulting to `interview-assistant`). An explicit
   endpoint is a deliberate operator decision, so it **always wins** — Langfuse
   keys left in the same env cannot hijack a Honeycomb deploy.
2. **`LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY`** — the zero-config path.
   The endpoint is derived, not configured. **Both** keys are required: half a
   credential builds an endpoint that 401s on every export for the life of the
   process, and a `BatchSpanProcessor` swallows that quietly — strictly worse
   than the console fallback, which at least shows you the spans.
3. **Neither** — `ConsoleSpanExporter`, spans to stdout. No signup, no config.

Neither side requires a backend. Nothing else changes between the three.

### GenAI semantic conventions

The spans carrying LLM usage also carry the OTel GenAI convention names, so an
LLM-aware backend groups them without per-attribute configuration:

| Span | Attribute | Aliased from |
|---|---|---|
| `session.cost` | `gen_ai.usage.input_tokens` | `usage.llm_input_tokens` |
| `session.cost` | `gen_ai.usage.output_tokens` | `usage.llm_output_tokens` |
| `session.cost` | `gen_ai.request.model` | `models.llm_model_id()` |
| `agent.turn-latency` | `gen_ai.request.model` | `models.llm_model_id()` |

These are **aliases, not new instrumentation** — the same numbers the aggregator
already had, under a second name. The `usage.*` keys stay exactly where they
were, because `eval/latency-report.ts` and every existing query read those.

What is deliberately **not** aliased: `gen_ai.prompt` and `gen_ai.completion`.
Langfuse renders them prominently and it is the obvious next thing to add —
which is the point of writing it down. Filling them would put CV text and
transcript content into a third-party backend. No span in this repo has ever
carried candidate content, and that is a property to keep on purpose rather
than lose by accident. (`practice.create-session` carries `cv.length` and
`cv.thin` — the size and a boolean, never the text.)

The agent supports one extra sink, independent of the primary exporter:
`OTEL_TRACES_FILE` adds a `JSONLSpanExporter` (`tracing.py`) that appends one
compact JSON object per span. Set it *alongside* Honeycomb to get live tracing
and a replayable artifact at the same time.

`install_tracer_provider()` is idempotent and runs from the worker's `prewarm`
hook (`agent.py`), which LiveKit re-runs per worker process — hence the guard.
It installs the **global** `TracerProvider`, so the LiveKit SDK's own tracer
resolves through it too (see "What the SDK emits" below).

## Cross-process propagation (the headline)

The trace crosses the process boundary on the **Firestore session document** —
not in the LiveKit JWT, and not in room metadata.

1. `createPracticeSession` (`lib/actions/practice.action.ts`) opens the root
   span `practice.create-session` via `traced()` (`lib/tracing.ts`).
2. Just before writing the session doc it calls `currentTraceparent()`
   (`lib/tracing.ts`), which formats the active span context as a W3C
   traceparent: `00-{trace_id}-{span_id}-{trace_flags}`.
3. The string is written onto the session document as `sessions/{id}.traceparent`
   — and only when non-null, so a doc written outside a span simply has no field.
4. `load_session_data()` (`session_data.py`) reads it back into
   `SessionData.traceparent`.
5. `entrypoint()` (`agent.py`) passes it through `context_from_traceparent()`
   (`tracing.py`), which calls `opentelemetry.propagate.extract()`, and opens
   `agent.panel-session` with that context as its explicit parent.

For the avoidance of doubt, since earlier revisions of this doc and the README
claimed otherwise:

- **NOT via the LiveKit JWT.** `mintSessionRoomToken()` (`lib/livekit.ts`) sets
  token metadata to `JSON.stringify({ sessionId })`. There is no traceparent in it.
- **NOT via room metadata.** Nothing in this repo writes LiveKit room metadata.

If the traceparent is absent (a session created before OTel was wired up, or one
created outside a span), `context_from_traceparent()` returns `None` and the
agent opens a fresh root trace instead. Both branches stamp
`trace.propagated` on `agent.panel-session`, so the unlinked sessions are one
filter away.

## Trace shape

Only spans that actually exist appear below.

```
practice.create-session                (lib/actions/practice.action.ts, via traced())
- interview.role, interview.level, panel.preset, panel.intensity
- user.id, cv.length, cv.thin, session.id
├─ phase1.generate-template
│  └─ ai.generateObject.* (AI SDK experimental_telemetry)
│     functionId=groq.generate-round-questions
│     gen_ai.* attributes: model, input/output tokens, finish reason
├─ firestore.template.write            firestore.doc=templates/{id}
├─ phase2.reground-against-cv          (SKIPPED when cv.thin=true)
│  └─ ai.generateObject.*              functionId=groq.reground-round-questions
└─ firestore.session.write             firestore.doc=sessions/{id}
                                       trace.propagated=true
   [traceparent written onto the session doc here]

  ─── process boundary (LiveKit dispatches the worker into room session-{id}) ───

agent.panel-session                    (agent.py::entrypoint — parented via the
                                        traceparent above)
- session.id, candidate.uid, interview.role, interview.level
- panel.preset, panel.intensity
- trace.propagated=true                ← the link to the Next side
├─ agent.on-enter                      round.id=<current round>
│                                      (not emitted on the resume path)
├─ agent.turn-latency                  one per assistant turn — see below
├─ agent.next-round                    from.round=<round being left>
├─ agent.turn-latency                  ...
├─ agent.end-interview                 round.id=<final round>
└─ session.cost                        (cost_aggregator.py::finalize)
```

Two notes on shape that surprise people reading the code for the first time:

- `agent.panel-session` is opened with `__enter__()` and closed in the
  entrypoint's `finally` **after** the cost rollup and the scoring hand-off, so
  its duration includes teardown.
- `agent.turn-latency` spans are opened and immediately closed
  (`metrics_bridge.py`). They are zero-duration markers whose payload is
  entirely in the attributes — the *duration* of a turn is not what they carry.

### `agent.turn-latency` in detail

Emitted from the `conversation_item_added` handler for every **assistant** turn
that reported any timing at all, reading LiveKit's `MetricsReport`
(`metrics_bridge.py`). Three legs are measured by the SDK:

| Attribute | Source field | Meaning |
|---|---|---|
| `latency.llm_ttft_ms` | `llm_node_ttft` | LLM first-token latency |
| `latency.tts_ttfb_ms` | `tts_node_ttfb` | TTS first-audio-byte latency |
| `latency.e2e_ms` | `e2e_latency` | User stops speaking → agent starts responding |
| `latency.playback_ms` | `playback_latency` | Optional; near-zero for room output |

**EOU is derived, not measured.** There is no end-of-utterance field on the
assistant `MetricsReport`. `latency.eou_ms` is computed *residually*:

```python
eou_delay_ms = max(0.0, e2e_ms - llm_ttft_ms - tts_ttfb_ms)
```

It therefore only exists when all three legs are present, and it absorbs
every unattributed millisecond in the turn (network, SDK overhead, the audio
turn detector's own decision time). Treat it as a remainder, not an instrument
reading. An `on_enter` greeting has no preceding user turn, so it has no EOU
delay at all — and the attribute is correctly absent rather than zero.

**The partial-span policy.** A turn missing any of the three legs is still
emitted, tagged `latency.partial=true`. This is deliberate and load-bearing:
partial reports come from interrupted turns and tool-call turns — i.e.
disproportionately the slow and abnormal ones. Dropping them (the old
behaviour) computed p95 over a sample that excluded exactly the turns most
likely to breach the budget, so the budget always looked satisfied. A missing
attribute is honest; a missing span is a lie by omission.

Attributes only ever carry legs that were actually measured — OTel rejects
`None`, and an absent attribute reads as "not measured" whereas a zero would
read as "instantaneous". Budgets are checked per-leg on the same principle: a
leg we didn't measure is *unknown*, not passing. Every span also carries the
four thresholds it was judged against (`budget.eou_p95_ms`,
`budget.llm_ttft_p95_ms`, `budget.tts_ttfb_p95_ms`, `budget.e2e_p95_ms`) plus
`latency.budget_violated`, and `latency.budget_violations` when non-empty.

### Latency budgets

Source of truth: `livekit-agent/src/interview_agent/latency_budget.py`. p95
targets, not averages — tail latency drives the perceived feel of a voice
interview far more than the mean.

| Budget key | p95 | Why |
|---|---:|---|
| `eou_delay` | 300 ms | The residual defined above. `endpointing.min_delay=0.4` (`pipeline.py`) is a floor beneath the audio turn detector, not the primary endpointing signal. |
| `llm_ttft` | 500 ms | Groq `openai/gpt-oss-120b`; Groq publishes 80–150 ms warm TTFT. The headroom covers cold connects and rate-limit retries. |
| `tts_ttfb` | 500 ms | ElevenLabs `eleven_flash_v2_5` over multi-stream WebSocket, `streaming_latency=3`. ElevenLabs' SLO for this model is ~200 ms. |
| `e2e_turn` | 1500 ms | User stops speaking → user hears first audio. Above ~2 s users start repeating themselves. |

The EOU budget deserves a caveat the number cannot express: with an audio
turn detector rather than a silence timer, holding the turn open through a
candidate's thinking pause is **correct behaviour**, not a budget miss. The
p95 is a guard against systemic drift, not a per-turn verdict.

## What the SDK emits

`install_tracer_provider()` sets the global provider, and LiveKit Agents' own
`telemetry.tracer` resolves lazily through it. So the SDK's spans — including
`job_entrypoint`, `agent_session`, `agent_turn`, `user_turn`, `llm_node`,
`tts_node`, `eou_detection`, `function_tool`, `on_enter` — export to the same
backend as ours, carrying `lk.*` attributes, without any extra wiring. They are
the SDK's contract, not ours; the `agent.*` spans above are what this repo
guarantees.

## Cost telemetry

Every session writes an estimated dollar cost broken down by provider. Sources
of truth: `lib/cost-rates.ts` (TypeScript) and
`livekit-agent/src/interview_agent/cost_rates.py` (Python mirror). Both carry
`RATES_SOURCED_AT` — currently **2026-07-17** — and both must be bumped
together when a number changes. Model ids are imported from
`interview_agent.models`, never retyped: this table once billed Deepgram
`nova-3` while the pipeline ran `nova-2`, so every cost figure on the dashboard
was wrong for a model that was never running.

Current rates, copied from `cost_rates.py` / `cost-rates.ts`:

| Provider | Model | Pricing dimension | Rate |
|---|---|---|---|
| Groq | `openai/gpt-oss-120b` | Input / output tokens | $0.15 / 1M in, $0.60 / 1M out |
| ElevenLabs | `eleven_flash_v2_5` | Characters synthesized | $0.05 / 1k chars (published API rate) |
| Deepgram | `nova-3` | Audio minutes | $0.0048 / minute streaming (monolingual, en-US) |
| LiveKit | WebRTC minutes | Participant-minutes | $0.0005 × 2 participants/session |

**How it flows:**

1. The entrypoint subscribes `SessionCostAggregator.handle_usage_event` to the
   SDK's `session_usage_updated` event (the recommended path; per-plugin
   `metrics_collected` is deprecated for usage tracking). The event carries
   *cumulative* totals, so the aggregator re-sums and overwrites rather than
   accumulating — a late correction can't double-count.
2. On teardown, `finalize()` (`cost_aggregator.py`) rolls the counts through
   `roll_up_cost()` into a `CostBreakdown`, emits the `session.cost` span with
   every usage count and dollar leg on it, and returns. The entrypoint writes
   the result to `sessions/{id}.estimatedCost` via `to_firestore_dict()`, which
   camel-cases the keys to match the TS `Session.estimatedCost` shape.
3. `finalize()` is idempotent — the first result is cached and returned on any
   subsequent call, because `session_duration` is sampled from
   `time.monotonic()` and would otherwise drift between calls. The entrypoint's
   `finally` path can fire from both the normal-end and error-end branches, and
   runs the rollup either way: a crashed session still records its partial bill.
4. The practice dashboard reads `Session.estimatedCost` and renders a per-row
   dollar figure plus a cumulative card.

Unknown models roll up to $0 rather than raising — the right failure mode for
an estimate if a provider is ever swapped at runtime.

**Disclaimer:** this is an estimate. Subscription plans, free tiers, volume
discounts, and regional pricing all change the real bill. `RATES_SOURCED_AT` is
the signal to revisit.

## Local dev (no signup required)

Leave `OTEL_EXPORTER_OTLP_ENDPOINT` unset and set no Langfuse keys. Both
processes fall back to
`ConsoleSpanExporter` and dump each span to stdout as it ends. The agent side
uses `SimpleSpanProcessor` specifically so spans appear immediately —
`BatchSpanProcessor` would delay console output by up to 5 s, which is
miserable when you are watching a turn happen.

## Backend setup

### Langfuse quickstart (the zero-config path)

Two keys, no endpoint. Langfuse is the recommended sink here because it reads
the `gen_ai.*` attributes above natively — token counts and model land in its
UI as LLM telemetry rather than as anonymous span attributes you have to build
a query for.

1. Create a free account and a project at
   [cloud.langfuse.com](https://cloud.langfuse.com).
2. **Settings → API Keys → Create new API keys.** Copy the public key
   (`pk-lf-…`) and the secret key (`sk-lf-…`). The secret is shown once.
3. Set both, in **one** place for local dev — the repo-root `.env.local` is
   read by the Next.js app and by the agent (`_load_env()` in `agent.py`):

```bash
# .env.local
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
# Only if you are not on the EU region or are self-hosting.
# Default: https://cloud.langfuse.com   US: https://us.cloud.langfuse.com
# LANGFUSE_HOST=https://cloud.langfuse.com
```

4. For deployed environments, set the same two vars on **both** sides:
   the Vercel project (Settings → Environment Variables) for the web spans,
   and the agent host's env for the agent spans. Both must be set — each
   process exports independently. Set only one and you get half the trace,
   which is a confusing way to find out.
5. Run a session. Traces appear under **Tracing → Traces**, keyed by the
   session's trace id — the *same* id across both processes, so the Next.js
   root span and the agent's spans land in one tree (see "Cross-process
   propagation" above). `session.cost` carries the dollar rollup;
   `agent.turn-latency` carries the per-leg timings.

Make sure `OTEL_EXPORTER_OTLP_ENDPOINT` is **unset** — it wins over these keys
by design (see the priority above), so leaving a stale Honeycomb endpoint in
your env means the Langfuse keys are read and then ignored. That is the first
thing to check if traces don't show up.

Under the hood: the derived endpoint is
`{LANGFUSE_HOST}/api/public/otel/v1/traces` with HTTP Basic auth over
`base64(public_key:secret_key)`, plus `x-langfuse-ingestion-version: 4` — an
optional header that opts into Langfuse Cloud's real-time ingestion, because a
trace you have to wait for is a trace you don't watch. Langfuse accepts OTLP
over both HTTP/JSON and HTTP/protobuf on that path, which is what lets the web
(JSON) and agent (protobuf) sides share one endpoint. gRPC is not supported.

> **Status: not yet verified against a live Langfuse project.** No account is
> wired to this repo, so the endpoint, auth scheme, and header above are
> verified against Langfuse's current docs and covered by unit tests
> (`test_tracing.py`) — but no trace has been watched landing in the UI. The
> first run with real keys is the confirmation, and it happens at the Phase-4
> smoke. Treat this section as instructions, not as a report of something
> already observed.

### Honeycomb (or any other OTLP backend)

Unchanged, and it still takes precedence over the Langfuse keys:

```bash
# .env.local
OTEL_EXPORTER_OTLP_ENDPOINT=https://api.honeycomb.io/v1/traces
HONEYCOMB_API_KEY=<your-key>
HONEYCOMB_DATASET=interview-assistant
```

The agent picks the same vars up from the repo-root `.env.local` via
`_load_env()` in `agent.py`, then from its own `.env` (which wins). No separate
config.

Grafana Cloud Tempo:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://tempo-prod-XX-prod-XX.grafana.net/otlp/v1/traces
# Tempo auth is Basic — pass via OTEL_EXPORTER_OTLP_HEADERS
```

Self-hosted Jaeger / OTel Collector: point at `http://otel-collector:4318/v1/traces`.

Note the asymmetry: the web side exports OTLP/HTTP+**JSON**, the agent exports
OTLP/HTTP+**protobuf**. Every backend above accepts both on the same endpoint;
a hand-rolled collector might not.

## Capturing a session for the replay analyzer

```bash
# In the agent's env (repo-root .env.local or livekit-agent/.env)
OTEL_TRACES_FILE=eval/sessions/2026-07-16-panel.spans.jsonl
```

Run a session normally, then point the analyzer at the file:

```bash
npm run latency-report -- eval/sessions/2026-07-16-panel.spans.jsonl

# Exit non-zero if any p95 leg exceeds its budget:
npm run latency-report -- eval/sessions/2026-07-16-panel.spans.jsonl --strict
```

The exporter appends, so reruns accumulate. The analyzer filters to the spans
it needs, so capturing everything is fine — no need to pre-filter the JSONL.
Captured session JSONLs live under `eval/sessions/` and are gitignored: commit
sanitised numbers, never raw transcripts.

## Verifying the propagation contract

`livekit-agent/tests/test_tracing.py` covers:

- `context_from_traceparent(None)` and `("")` both return `None`
- A valid traceparent yields a usable `Context`
- `install_tracer_provider()` is idempotent (LiveKit re-runs `prewarm`)
- A span opened under a propagated context inherits the exact trace_id encoded
  in the parent traceparent
- A span opened with no propagated context starts a fresh root trace

The fourth is the load-bearing one. If it fails, distributed traces are broken
end-to-end and the `trace.propagated` attribute is lying.

It also pins `_resolve_otlp_config()` — the sink priority: Langfuse keys derive
the right endpoint and Basic auth header, `LANGFUSE_HOST` is honoured (trailing
slash stripped), an explicit endpoint outranks the keys and keeps its Honeycomb
headers with no Langfuse auth smuggled onto it, one key alone resolves to
`None`, and no config at all resolves to `None`. Every var these tests read is
explicitly set or deleted per-test: the agent loads the repo-root `.env.local`
at import, so anything left implicit would pass or fail depending on test order
and on what a given developer has in their env.

The equivalent chain in `instrumentation.ts` is **not** unit-tested — it is
open-coded in `register()`, which has no seam to test it through. It's ~15
lines mirroring a tested function; the risk is drift between the two, and the
mitigation is that they sit in the same commit and this doc names both.

## What's NOT here

Stated plainly, because an observability doc that overclaims is worse than none:

- **No metrics.** No counters, no histograms, no meter provider. Span
  attributes only. Percentiles are computed offline by
  `eval/latency-report.ts` from a JSONL capture, not by a metrics backend.
- **No in-repo dashboard.** The "dashboard" is Langfuse's own trace UI (or
  whatever queries you write in Honeycomb/Tempo), plus the cost card the
  practice UI renders from Firestore. Nothing in this repo renders a chart of
  its own telemetry.
- **No Langfuse-native features beyond OTLP ingestion.** No `langfuse` SDK, no
  prompt management, no datasets, no scores pushed to it, no sessions/users
  linked. It is an OTLP sink that happens to understand `gen_ai.*` — the repo
  stays portable to any OTLP backend, and swapping it out is two env vars.
- **No per-turn cost attribution.** By design: correct per-turn attribution
  needs the deprecated per-plugin events, and per-session totals are the right
  granularity for "how much did that session cost". Per-turn cost is a
  curiosity; per-session is the bill.
- **No dedicated HTTP-client spans** for Groq / ElevenLabs / Deepgram. The
  agent ships no `opentelemetry-instrumentation-httpx`/`-requests`
  (`livekit-agent/pyproject.toml`). The SDK's `llm_node` / `tts_node` spans
  cover the node; the wire call inside it is not separately timed.
- **No browser spans.** `@vercel/otel` is server-side only. Tracing the user's
  "Start Interview" click into `practice.create-session` would need a browser
  SDK — a separate workstream.
- **HR-mode routes are not instrumented.** Dormant by design.

## Files

```
instrumentation.ts                          Next.js OTel bootstrap (registerOTel)
lib/tracing.ts                              traced() + currentTraceparent()
lib/livekit.ts                              JWT minting (metadata = {sessionId} only)
lib/cost-rates.ts                           TS price registry + rollUpCost()
lib/actions/practice.action.ts              root span + traceparent → session doc
livekit-agent/src/interview_agent/
  tracing.py                                OTel bootstrap, JSONLSpanExporter,
                                            context_from_traceparent()
  agent.py                                  agent.panel-session / on-enter /
                                            next-round / end-interview spans
  session_data.py                           reads traceparent off the session doc
  latency_budget.py                         per-stage p95 thresholds + violated()
  metrics_bridge.py                         MetricsReport → agent.turn-latency
  cost_rates.py                             Python price mirror + roll_up_cost()
  cost_aggregator.py                        SessionCostAggregator + session.cost span
  models.py                                 model ids — single source of truth
livekit-agent/tests/
  test_tracing.py                           propagation contract
  test_latency.py                           budget + bridge
  test_cost.py                              cost rates + aggregator
tests/cost-rates.test.ts                    TS cost-rate tests (incl. TS↔Python parity)
eval/latency-report.ts                      offline percentile analyzer (latency + cost)
docs/observability.md                       (this file)
```
