# TECH DECISIONS — JobVoice / Interview Assistant

> **Docs set:** [Index](README.md) · [Architecture](ARCHITECTURE.md) · Tech Decisions · [Glossary](GLOSSARY.md) | deep dives: [security](security.md) · [observability](observability.md) · [resume](resumable-sessions.md)

> Every framework, library, provider, and pattern in the codebase: what it does,
> and why it was chosen over alternatives.
>
> **Rule:** where the code or its comments state a rationale, it's cited. Where
> the rationale is a reasonable inference but not written down, it's tagged
> **[ASSUMED]** — say so honestly. Versions are from `package.json` and
> `livekit-agent/pyproject.toml`.
>
> Decisions that have since been **superseded** are not deleted — they're in
> §10 with the reason and date. A decision log that shows evolution is worth
> more than one that pretends the first guess was right.

---

## 1. Frameworks & runtime

### Next.js 15 (App Router, Turbopack) — `next ^15.2.4`
- **Does:** React framework; App Router with route groups, Server Actions, and
  Route Handlers; renders the UI and hosts the server tier.
- **Why:** Server Actions + Route Handlers keep every secret (LiveKit API
  secret, Groq key, Gemini key, Firebase Admin cert) server-side while
  colocating them with the UI. The LiveKit-JWT mint is explicitly a server
  action so the secret never reaches the browser (`ONBOARDING.md` §6). Over a
  separate Express/Nest backend: one deploy target, no CORS, typed end-to-end.
  **[ASSUMED]** for the React-framework choice itself.

### React 19 + TypeScript 5 — `react ^19.0.0`, `typescript ^5`
- **Does:** UI rendering; static typing across client + server.
- **Why:** Latest React for `use`/Server Components in App Router. TypeScript
  gives the shared **ambient domain types** (`types/index.d.ts`) both sides rely
  on without imports. **[ASSUMED]**.

### Python 3.11 + LiveKit Agents 1.6 — `livekit-agents>=1.6.1,<2`
- **Does:** The voice-agent runtime — connects to a LiveKit room, runs the
  STT→LLM→TTS pipeline, manages the agent lifecycle, forks a subprocess per job.
- **Why:** This is the **load-bearing reason the system is two services**. The
  mature voice-agent + plugin ecosystem (Deepgram, ElevenLabs, Silero,
  OpenAI-compatible LLM) is Python-native, and the pipeline is a long-lived,
  stateful, audio-streaming process that cannot run in a serverless function.
  Over building voice orchestration on raw WebRTC: enormous.
- **Pinned `>=1.6.1` deliberately** for `livekit.agents.inference.TurnDetector`
  — the audio end-of-turn model ships *inside* `livekit-agents`; the separate
  `livekit-plugins-turn-detector` package is deprecated and slated for removal,
  so it must not be added back (`pyproject.toml` comment).

---

## 2. Real-time transport & voice providers

### LiveKit Cloud (WebRTC SFU) — `livekit-client ^2.18.9`, `livekit-server-sdk ^2.15.2`
- **Does:** Carries bidirectional audio between browser and agent;
  auto-dispatches the registered Python worker into the room on participant
  join.
- **Why:** WebRTC SFU is the right tool for low-latency, full-duplex voice (vs
  raw websockets or HTTP streaming). LiveKit Cloud also gives the **dispatch
  model** that lets the browser start an interview without the Next.js server
  holding an agent connection — the worker self-selects rooms by the `session-`
  prefix (`agent.py::_request_fnc`). Token minting via `livekit-server-sdk`
  (`lib/livekit.ts`); the JWT's metadata carries `{ sessionId }` and nothing else.

### Deepgram Nova-3 (STT) — `livekit-plugins-deepgram`
- **Does:** Streaming speech-to-text. Runtime config:
  `deepgram.STT(model=STT_MODEL, language="en-US")` (`pipeline.py`), where
  `STT_MODEL = "nova-3"` (`models.py`).
- **Why:** Best-class low-latency streaming WS STT. Nova-3 over Nova-2 is not a
  trade-off to weigh — streaming WER 8.4% → 6.84% at latency parity; nova-2 is
  simply the older model (`models.py`).

### Groq `openai/gpt-oss-120b` (LLM) — `@ai-sdk/groq` (web), `livekit-plugins-openai` (agent)
- **Does:** The live interviewer (agent) and question generation + grounding
  (Next.js). **Not** scoring — see the judge below.
- **Why Groq:** **Latency.** A voice interview is bottlenecked on LLM
  time-to-first-token; Groq publishes 80–150 ms TTFT for warm requests
  (`latency_budget.py`), dramatically faster than typical hosted GPT-4-class
  models, which is the single biggest lever on perceived conversational latency.
  The agent reaches Groq through `livekit-plugins-openai` against Groq's
  **OpenAI-compatible** endpoint (`pipeline.py`, `GROQ_BASE_URL`), so no custom
  client is needed.
- **Why gpt-oss-120b:** Groq decommissions `llama-3.3-70b-versatile` on
  2026-08-16. gpt-oss-120b is faster (~500 vs ~280 tok/s), cheaper, and is one
  of only **two** Groq models supporting strict `json_schema` decoding — which
  is what lets the schemas be enforced server-side instead of begged for in the
  prompt (`lib/groq.ts`, `models.py`).
- **Model ids live in exactly one place per side** — `models.py` (Python) and
  `lib/groq.ts` / `lib/judge.ts` (TS) — and are imported everywhere else. This
  exists because of a bug class, not tidiness: the id was once retyped in the
  pipeline, the cost table, the latency docstring, the turn metadata, and the
  tests, and they drifted. The pipeline ran nova-2 while the cost table billed
  nova-3, so the dashboard was confidently wrong — and the test that claimed to
  catch exactly that passed anyway, because it compared one hardcoded string to
  another (`models.py` docstring).
- **Multi-account failover:** Groq's free tier caps tokens-per-day **per
  account**, so `groqApiKeys()` collects `GROQ_API_KEY1/2/3` (+ legacy
  `GROQ_API_KEY`) and `withGroqModel` rotates on a 429 (`lib/groq.ts`). The live
  pipeline uses only the first key — one interview is well under one account's
  daily budget — while the audit runner, which fires the whole corpus rapidly,
  does the real rotating (`pipeline.py`, `security/runner.py`).

### Google `gemini-3.1-flash-lite` (judge) — `@ai-sdk/google`
- **Does:** Scores the transcript per round and writes the bar verdict
  (`lib/judge.ts`, `lib/llm/judge-report.ts`).
- **Why a different family from the interviewer — the load-bearing reason:** if
  one model holds a wrong belief (say about Postgres isolation levels) it will
  **both** fail to probe a candidate's correct answer **and** mark that correct
  answer wrong when grading. The error lives in the weights, not the context, so
  a fresh stateless call does not fix it; only a different model family does.
  Correlated errors are the failure mode; family diversity is the mitigation.
- **Why Flash-Lite over Flash:** the Flash tier is ~6× the price this generation
  and does not buy proportionally better rubric adherence. Flash-Lite is GA,
  supports strict JSON-schema decoding, and costs ~$0.0035 per judge call.
  Scoring is **offline** — nobody is waiting on it — so the model is chosen for
  reasoning quality, not throughput. That is precisely why it isn't gpt-oss.
- **Billing MUST be enabled on the key.** Google's free tier uses submitted
  content to improve their products, and this call carries candidate CVs and
  transcripts (PII). The paid tier does not train on prompts and allows 7-day
  log retention. There is no way to detect the tier from the client, so it's
  enforced by convention and a loud error message (`lib/judge.ts`).
- **No failover here**, unlike Groq: scoring is one call per interview on a paid
  key, not a quota-constrained hot path. If it fails, surface the failure — a
  report that quietly fell back to a weaker model is worse than no report.

### ElevenLabs `eleven_flash_v2_5` (TTS) — `livekit-plugins-elevenlabs`
- **Does:** Per-panelist streaming TTS. Each panelist gets its own prewarmed
  `elevenlabs.TTS` with a distinct voice id + `VoiceSettings`, built from the
  spec on the session doc (`agent.py::_build_tts_for_spec`).
- **Why:** High-quality low-latency streaming voices, and **distinct voices per
  panelist** are what sell the panel illusion. Flash over Turbo because
  ElevenLabs deprecated the Turbo line and their guidance is explicit: use Flash
  in all cases — same voices, lower first-byte latency, same price (`models.py`,
  `lib/cost-rates.ts`).
- `streaming_latency=3` opts into the "max latency optimization" profile while
  keeping text normalization on; 4 disables normalization and risks
  mispronouncing numbers and abbreviations, which in an interview domain is a
  real cost. An explicit, reasoned tuning choice (`agent.py`).
- **TTS is deliberately NOT on the session** (`pipeline.py` omits it): the
  overridden `PanelAgent.tts_node` owns synthesis entirely, because voice
  selection happens *per speaker-tagged run within one LLM response*, not per
  agent.

### Silero VAD — `livekit-plugins-silero`
- **Does:** Voice-activity detection, pre-loaded once per worker in `prewarm`
  (`agent.py`).
- **Why:** Standard local VAD; running it locally avoids a network round-trip in
  the turn loop. Still required underneath the turn detector — but VAD only
  knows "is there sound", which is not the question "are they finished".

### The audio TurnDetector, not a silence timer — `pipeline.py`
- **Does:** `TurnDetector(unlikely_threshold=0.45)` decides when the candidate
  has finished, running on **audio directly** rather than the transcript.
- **Why:** A silence timeout is a pure latency tax with no signal in it — every
  response waits out the full timeout whether the candidate finished a sentence
  or trailed off mid-thought. Interviews are the worst case for that, because
  thinking pauses are the whole point: *"so the tricky part was… [3s] …the
  idempotency key"* is one turn that VAD-only endpointing chops in half.
  Measured on LiveKit's eot-bench at a 300 ms latency budget: false-cutoff rate
  9.9% vs ~27.7% VAD-only — ~3× fewer interruptions at the same latency. Running
  on audio also costs no STT round trip and sees prosody a text model
  structurally cannot.
- `unlikely_threshold` is nudged **down** from the 0.5–0.6 default: it is the bar
  for declaring a turn over, so lowering it makes the agent more willing to keep
  waiting.

### Turn-taking is tuned, not default — `pipeline.py::_INTERVIEW_TURN_HANDLING`
- **Does:** interruption `min_duration=1.0` **and** `min_words=3`,
  `resume_false_interruption=True`, `false_interruption_timeout=2.0`;
  endpointing `min_delay=0.4`, `max_delay=3.0`.
- **Why — the governing trade-off, stated once:** cutting a candidate off
  mid-thought is a worse failure than being half a second slow. Worse as a
  product (they lose their train of thought, and the answer we score is not the
  answer they had) and worse as a fairness matter (people who pause to think,
  speak a second language, or are simply careful get truncated more). So every
  value buys patience with latency, deliberately. LiveKit's defaults (0.5 s / 0
  words) cut candidates off on filler sounds like "uh"/"mm".
- `min_delay` **0.8 → 0.4** is not a regression in patience: it is the *point*
  of adopting the turn detector. That delay used to be the only thing between a
  thinking pause and the agent barging in, so it had to be padded for the worst
  case and every turn paid for it. Now it is just a floor beneath a model that
  judges turn-final prosody. Net: ~400 ms off every turn **and** fewer cutoffs.
  `max_delay=3.0` is generous on purpose — a candidate reasoning aloud through a
  system-design question pauses for seconds mid-thought, and that is exactly
  when we most want to hear the rest.

---

## 3. AI / prompting patterns

### Vercel AI SDK (`ai ^6.0.175`) + `@ai-sdk/groq` + `@ai-sdk/google`
- **Does:** `generateObject()` with a Zod schema for structured output on the
  Next.js side (question gen, grounding, judging).
- **Why:** Schema-validated structured generation in one call, with
  `experimental_telemetry` emitting `gen_ai.*` OTel spans for free.
- **Strict decoding, with a caveat that cost real debugging:** the code uses
  `providerOptions: { groq: { structuredOutputs: true } }` — gpt-oss-120b is one
  of only two Groq models that support it. **But** on gpt-oss models Groq
  validates *after* generation instead of grammar-constraining it, so the model
  can still emit invalid JSON and the call 400s with `json_validate_failed`
  (measured ~45% per attempt on the 3-round panel schema). The AI SDK correctly
  classifies 400s as non-retryable, so without help every pipeline call got one
  shot at a coin flip. Hence **`withSchemaRetry`** (`lib/llm/schema-retry.ts`):
  up to 5 attempts, retrying **only** the generation-validation class and
  `NoObjectGeneratedError` — never a 401 or a deterministic schema rejection,
  which fail identically every time and would just burn quota. It unwraps
  `RetryError` to the terminal error so a rate-limited-then-validate-failed call
  still retries, and it wraps `withGroqModel` *inside* itself so each attempt
  gets the full multi-account failover. The inline shape descriptions in the
  prompts remain load-bearing for the same reason (git `35b9526`).
- **Strict mode requires every property in `required`**, so optional fields are
  expressed as `.nullable()`, not `.optional()` — `cvReference` being
  `.optional()` made Phase-2 grounding 400 deterministically.
  `tests/groq-schema-strict.test.ts` walks the SDK-derived JSON schema of every
  Groq-bound zod schema and fails on any property missing from `required`,
  making the class unrepresentable rather than merely fixed.

### Two-phase question generation — `lib/llm/groq-template.ts`, `groq-grounding.ts`
- **Does:** Phase 1 (`generateRoundQuestions`) produces per-round questions +
  base rubrics from role/level/JD in **one** Groq call, against a schema **built
  from the preset's round ids** so strict decoding enforces exactly this panel's
  shape. Phase 2 (`regroundRoundQuestions`) rewrites them against the CV.
- **Why split:** separates *what to ask for this role* from *how to phrase it
  for this candidate*, so a template is reusable with per-candidate grounding.
- **Why Phase 2 is skippable:** below `CV_TOKEN_FLOOR_CHARS = 2_400` (~600
  tokens) the CV is too thin to reground against — rewriting questions against
  300 words fabricates specificity the interview then confidently probes. A
  JD-grounded base question is the *right* question for a thin CV. The session
  records which happened (`grounding: "jd-only" | "cv"`).

### The CV and JD are inlined in the prompt, not retrieved
- **Does:** `render_panel_prompt` inlines both documents in full, clipped to
  `_DOC_CHAR_BUDGET = 16_000` chars each (`persona.py`).
- **Why:** see §10 — this replaced a per-session vector index.
- **Why 16k chars when storage allows 50KB:** the 50KB cap is a *storage* limit.
  The system prompt is re-sent on every turn, so an outlier 50KB CV would be
  ~12k tokens billed 30 times over. 16k chars ≈ 4k tokens comfortably fits any
  real CV (a dense two-page CV is ~4–5k chars); the cap only bites on
  pathological input. Truncation is **marked** in the text, because silently
  truncating a CV would make the interviewer confidently believe a candidate's
  last job doesn't exist.

### One prompt roleplays the panel; speaker tags route the voice
- **Does:** `_PANEL_TEMPLATE` casts the LLM as all N interviewers under a strict
  `[NAME]` speaker protocol; `PanelAgent.tts_node` routes each contiguous run to
  that panelist's TTS (`persona.py`, `agent.py`, `panel_tts.py`).
- **Why:** it delivers what a relay structurally cannot — interviewers who share
  the room, interject, and build on each other — with *less* code than the relay
  needed. Tags are parsed only from LLM output, so candidate speech can't forge
  one.

### Rotation-median judging — `lib/llm/judge-report.ts`
- **Does:** scores each transcript `PERMUTATIONS = 3` times with the rubric
  criteria **rotated**, then takes the per-criterion median.
- **Why:** criterion **order alone** shifts LLM-judge scores by up to 0.8 points
  on a 5-point scale and flips the top-ranked candidate in 16–39% of cases —
  an enormous effect for something that carries zero information. Rotation
  rather than shuffle keeps it deterministic, so a report is reproducible and
  the eval harness can compare runs. 3 rotations captures ~⅔ of the achievable
  debiasing gain; 5 captures ~85%. Median, not mean, because it's robust to a
  single outlier run. Spread across runs is surfaced as `maxDisagreement` —
  disagreement is displayed as low confidence, not hidden.

---

## 4. Auth & data

### Firebase Auth (session cookies) — `firebase ^11.4.0`, `firebase-admin ^13.2.0`
- **Does:** Client signs in → ID token → server exchanges it for a 7-day
  **session cookie** via the Admin SDK (`lib/actions/auth.action.ts`).
- **Why:** httpOnly session cookies keep auth server-verifiable on every request
  without shipping a long-lived token to JS. **[ASSUMED]** for picking Firebase
  over Auth.js/Clerk — consistent with pairing it with Firestore for zero-ops.
- **Gotcha encoded in code:** `FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n")`
  normalizes the escaped-newline env var (`firebase/admin.ts`) — the single most
  common setup failure.

### Firestore (NoSQL document DB)
- **Does:** The cross-service state + authorization spine (`ARCHITECTURE.md` §9).
- **Why:** serverless, security rules at the edge, and **the same DB is reachable
  from both Next.js (Admin SDK) and the Python agent (service account)** — a
  relational DB would need a shared connection layer. Rules enforce ownership
  and make every core-collection write server-only (`allow write: if false`), so
  a candidate can never write their own score. Trade-off: no joins (the code
  does in-memory joins, e.g. `getPracticeHistory`), and composite indexes are
  avoided via single-field queries + in-memory sort. **[ASSUMED]** on the
  relational-vs-document choice.
- **Batched reads, learned the hard way:** `getPracticeHistory` used to `await`
  a template get and a report get *inside* its loop, so a user with 20 sessions
  paid 40 sequential round trips to render one dashboard — latency that grew
  linearly with how much someone used the app. Now two `db.getAll()` calls.

---

## 5. UI / forms / styling

| Library | Version | Does | Why |
|---|---|---|---|
| Tailwind CSS 4 | `^4` | Utility-first styling; token-driven dark design system in `app/globals.css` | Fast iteration; tokens (`surface-*`, `accent`, …) drive the whole system. **[ASSUMED]** |
| Radix UI | `react-label`, `react-slot` | Accessible primitives behind shadcn-style components in `components/ui/` | Standard shadcn stack; accessibility for free. **[ASSUMED]** |
| `class-variance-authority`, `clsx`, `tailwind-merge` | — | Variant + className composition (the `cn()` helper) | Canonical shadcn tooling. **[ASSUMED]** |
| React Hook Form + Zod | `^7`, `^4`, `zod ^3.24.2` | Form state + schema validation | One Zod schema validates both the form *and* the LLM output shape — schema reuse (`constants/index.ts`) |
| `sonner` | `^2` | Toasts | Lightweight; surfaces action failures. **[ASSUMED]** |
| `lucide-react`, `next-themes` | — | Icons; theming | Standard. **[ASSUMED]** |
| `dayjs` | `^1.11` | Date formatting | Small footprint vs moment. **[ASSUMED]** |
| `mammoth`, `unpdf` | `^1.12`, `^1.6` | Extract text from DOCX / PDF CVs (`lib/cv-parse.ts`) | Pure-JS extraction, so CV parsing runs in the Next.js runtime without a service; text capped at 50KB |

---

## 6. Observability stack

| Library | Where | Does | Why |
|---|---|---|---|
| `@vercel/otel`, `@opentelemetry/*` | Next.js (`instrumentation.ts`, `lib/tracing.ts`) | Spans for server actions + LLM calls; generates the W3C `traceparent` | Vendor-neutral; exports to any OTLP endpoint (Honeycomb headers supported) |
| `opentelemetry-{api,sdk,exporter-otlp-proto-http}` | Python agent (`tracing.py`) | Continues the same trace; emits `agent.panel-session`, `agent.on-enter`, `agent.turn-latency`, `agent.next-round`, `agent.end-interview`, `session.cost` | **Cross-process trace continuity** — the agent rehydrates the Next.js `traceparent` from the session doc, so one trace covers create→interview |
| Custom `JSONLSpanExporter` | `tracing.py` | Dumps spans as JSONL for offline replay | Lets `eval/latency-report.ts` compute p50/p95/p99 with no tracing backend |

`proto-http` specifically: it rides plain HTTPS, so no collector and no gRPC
dependency (`pyproject.toml`).

**Why OTel at all (vs logs):** the system is distributed across browser →
Next.js → Firestore → LiveKit → Python; a single trace id is the only way to
follow one interview end-to-end. Full design: `docs/observability.md`.

---

## 7. Testing & quality gates

| Tool | Scope | What it gates |
|---|---|---|
| **Vitest** `^4.1.6` | Next.js — 10 files, **89 tests** (verified: `npm test`) | Zod schemas, Groq strict-schema conformance, schema-retry classification, cost-rate math (incl. TS↔Python agreement), presets, clearance, judge, eval baseline-check |
| **pytest** | Python agent — 18 modules, **152 tests** (verified: `uv run pytest`) | Panel prompt + tag routing, PanelAgent, `TransferGuard`, leak detection, latency budgets, cost, resume, persistence, tracing, pipeline |
| **Eval harness** (`eval/run.ts`) | Question generation — 10 fixtures, 4 weighted deterministic scorers (cvGrounding 0.35, partitionCorrectness 0.30, hallucinationGuard 0.20, schemaPass 0.15; no LLM-as-judge) | Fails when any per-fixture metric drops >10pp vs `baselines.json` |
| **Injection audit** (`security/run_audit.py`) | Security — **54 cases / 10 categories**, one call each at grill intensity, declarative predicates | Fails when a previously-passing case regresses vs `security_baseline.json` (52 passing) |

- **Why deterministic scorers over LLM-as-judge** in the eval: reproducible,
  zero-cost, no judge-model variance.
- **Why a 10pp threshold, not 5:** LLM output is non-deterministic and a single
  question misclassification on a 9-question fixture swings partition
  correctness ~11pp. The honest alternative is `temperature=0` in production,
  but creative variation in interview questions is desirable — so the noise is
  tolerated in the gate instead (`eval/run.ts`).
- **Why the baseline pins the model:** the gate subtracts baseline from current;
  across models that delta measures a *swap*, not a regression. Mismatch
  hard-fails; `--allow-model-mismatch` downgrades to a loud skip for local
  experiments (`eval/baseline-check.ts`).
- **Why both LLM gates are schedule-only:** they're nondeterministic and cost
  Groq tokens, so they run weekly + on dispatch rather than blocking every push
  — which keeps trunk from flaky-redding on model variance. The deterministic
  gates block every push/PR (`.github/workflows/ci.yml`).
- **Both baselines are committed** (`eval/baselines.json`,
  `livekit-agent/security_baseline.json`) — a gate whose baseline lives only on
  someone's laptop gates nothing.

---

## 8. Build / deploy / tooling

| Thing | Choice | Why |
|---|---|---|
| Package manager (Python) | `uv` (pinned in Docker) | Fast, reproducible |
| Container | `livekit-agent/Dockerfile` | The worker is long-lived; deploy on Render / Fly.io (see its README) |
| Web hosting | Vercel + a daily cron (`vercel.json`) | `maxDuration` is capped at **60** — the Hobby plan's hard ceiling; exporting more fails the whole deployment. Hobby also rejects sub-daily cron schedules |
| `tsx` | Runs `eval/run.ts`, `latency-report.ts` directly | No build step for tooling scripts |
| Dependabot bumps | Visible in git history | Security hygiene — transitive CVE fixes |

---

## 9. Cross-cutting patterns (why it's not a typical CRUD app)

1. **Security-in-code, not security-in-prompt.** Deterministic `TransferGuard`
   preconditions + post-hoc leak detection; the prompt rule is explicitly
   belt-and-suspenders (`security_guards.py`, `persona.py`).
2. **One prompt, N voices.** The panel is a prompt protocol plus a TTS router,
   not an agent graph (`agent.py::PanelAgent.tts_node`).
3. **Schema as the single source of truth.** Zod schemas in `constants/index.ts`
   validate LLM output, forms, and the Firestore round-trip; the Python
   `Turn`/`CostBreakdown` dataclasses mirror the same camelCase shapes via
   `to_firestore_dict()`.
4. **Doc as contract, mirrored by hand.** `lib/cost-rates.ts` mirrors
   `cost_rates.py`; both carry "keep in sync" comments and a shared
   `RATES_SOURCED_AT` date stamp, because there's no codegen — a deliberate,
   acknowledged trade-off.
5. **One definition per model id.** Anything naming a model imports it from
   `models.py` / `lib/groq.ts`, so the cost table cannot disagree with the
   pipeline about what is running.
6. **Prewarm everything model-shaped.** Silero VAD loads once per worker in
   `prewarm`, not mid-call, alongside the OTel provider install (`agent.py`).
7. **Idempotent, crash-safe teardown.** The cost rollup runs in a `finally` even
   on error paths so a crashed session still records partial spend;
   `finalize()` caches its first result to stay idempotent; the durable
   `awaiting-report` marker is written before the best-effort ping.
8. **Module-globals-per-subprocess.** Relies on LiveKit forking one subprocess
   per job to make module-level state session-scoped (`agent.py`) — pragmatic,
   with a real trade-off: the module is not importable twice in one process, and
   the tests reset the globals explicitly.
9. **Honest observability.** Partial latency reports are emitted tagged rather
   than dropped, because the dropped ones were disproportionately the slow turns
   — survivorship bias in the observability layer manufactures confidence
   (`metrics_bridge.py`).

---

## 10. Superseded decisions

Kept, not deleted. Each was a real decision, and each was reversed for a reason
worth knowing.

### ~~LlamaIndex + FastEmbed `BAAI/bge-small-en-v1.5` per-session RAG~~
**Superseded: 2026-07 (panel rework). Replaced by: inlining the CV + JD in the prompt.**

- **Was:** a per-session in-memory `VectorStoreIndex` over the CV + JD, powering
  `lookup_cv_jd` (top-k retrieval) and `verify_cv_claim` (cosine similarity
  binned into supported ≥0.55 / ambiguous 0.40–0.55 / unsupported <0.40),
  in `rag.py`. FastEmbed was CPU-only, needed no API key, and was prewarmed at
  worker startup to avoid a ~3 s first-session load.
- **Why it was reversed:** the machinery solved a context-window problem that
  does not exist here. **A CV and a JD together are a few thousand tokens and
  simply fit.** What it cost was a synchronous index build blocking the event
  loop before the first greeting, a model download to prewarm, three
  dependencies, and an extra LLM round trip inside any turn that used the tool —
  to look up a document we could just… include (`persona.py`).
- **What replaced the claim-checking:** rather than a similarity verdict, the
  prompt tells the panel the CV is in front of them and to read it directly —
  and, crucially, **not** to accuse: people work on things they never wrote
  down. The instruction is to ask them to walk through it and judge whether they
  talk about it like someone who was actually there (`persona.py::COMMON_RULES`).
  That is both kinder and a better signal than a cosine threshold.
- **Residue:** `rag.py` and its dependencies are gone from `pyproject.toml`. Some
  audit-corpus predicates still name the deleted tools — see the known gap in
  `docs/security.md`.

### ~~Three `Agent` subclasses relaying via `transfer_to_*` hand-off~~
**Superseded: 2026-07 (panel rework). Replaced by: one `PanelAgent` + `tts_node` voice routing.**

- **Was:** `BehavioralInterviewer` → `TechnicalInterviewer` →
  `SystemDesignInterviewer`, each owning its own TTS, handed off using LiveKit
  Agents' native pattern (a `@function_tool` returning `tuple[Agent, str]`, with
  `chat_ctx` forwarded so the next interviewer saw the prior conversation).
- **Why it was reversed:** a relay is a sequence of monologues. Only one agent is
  active at a time, so interviewers structurally **cannot** interject,
  cross-examine, or disagree with each other — which is the entire product.
  One agent roleplaying the panel delivers that with *less* code, and rounds
  become prompt structure (`update_instructions`) rather than object lifecycle.
- **What survived:** the personas remain as **data** (names, expertise, voice
  ids, `VoiceSettings`) and are now written onto the session doc from
  `lib/presets.ts`. `TransferGuard` also survived, still gating the
  round-advance tool — the tool is now `next_round`, but the turn-count
  precondition is unchanged. Its class and method names still say "transfer"
  (noted in `docs/security.md`).
- **Residue:** `persona.py` still carries the relay-era `GENERAL_TEMPLATE`,
  `HANDOFF_RULE`, `render_system_prompt`, and the three `Persona` constants.
  The constants are live — `_legacy_panel_spec()` reads their voice ids to
  synthesize a panel for pre-preset session docs. The template and
  `render_system_prompt` are exercised only by tests.

### ~~ML input classifier (DeBERTa / `llm-guard`) as security Layer 1~~
**Superseded: git `c6bfe0d`. Replaced by: deterministic `TransferGuard` preconditions.**

- **Was:** an ML prompt-injection classifier screening candidate input before it
  reached the LLM.
- **Why it was reversed:** it was a probabilistic gate in a hot path where a
  deterministic one is available. A turn-count precondition on the state-changing
  tools is *provable* — a 0-turn round-skip cannot succeed regardless of phrasing
  — whereas a classifier has a false-negative rate, adds latency to every turn,
  and needs a model loaded in the worker. The classifier also guarded the wrong
  thing: it screened input, while the outcome we actually care about is whether a
  **tool fires**.

### ~~`recommendation` enum on the report~~
**Superseded: panel rework. Replaced by: `barVerdict: "advance" | "not-yet"`.**

- **Was:** a hiring-style recommendation enum on the report doc.
- **Why it was reversed:** nobody is being hired here. This is practice, so
  hiring vocabulary is both wrong and misleading about what the score means. The
  question a prep user actually has is *"would this panel have advanced me, and
  what do I fix first?"* — so the report ends with `advance | not-yet` at the
  stated level plus the single highest-leverage focus area.
- **Residue:** `PracticeHistoryRow.recommendation` is retained and explicitly
  marked `LEGACY: pre-bar-verdict reports only` so old reports still render
  (`lib/actions/practice.action.ts`).

### ~~Groq `llama-3.3-70b-versatile` + `json_object` mode~~
**Superseded: 2026-07. Replaced by: `openai/gpt-oss-120b` + strict `json_schema`.**

- **Was:** llama-3.3-70b at $0.59/1M in, $0.79/1M out. It did **not** support
  strict `json_schema`, so the code used
  `providerOptions: { groq: { structuredOutputs: false } }` (json_object mode),
  put the literal word "JSON" in the prompt, described the shape inline, and let
  the SDK validate against Zod client-side.
- **Why it was reversed:** Groq decommissions it on 2026-08-16. gpt-oss-120b is
  faster (~500 vs ~280 tok/s), cheaper ($0.15/$0.75), and supports strict
  decoding.
- **What it cost:** strict mode on gpt-oss is validate-after-generation, which
  introduced the `json_validate_failed` class that `withSchemaRetry` now absorbs
  (§3). The inline shape descriptions were kept for exactly that reason.

### ~~Report triggered by the browser's `RoomEvent.Disconnected`~~
**Superseded: replaced by the durable `awaiting-report` marker + cron reconciler.**

- **Why it was reversed:** it made the least reliable component in the system — a
  tab on a candidate's laptop — the commit step for the product's only real
  output. Close the lid, lose wifi, or force-quit and the interview was never
  scored, with no retry and no record that anything was missing. The agent is the
  only party that actually knows the interview ended, so it writes that fact down
  durably and the scoring side is driven from the written fact (`reporting.py`).

### ~~Deepgram `nova-2`~~
**Superseded. Replaced by: `nova-3`.**

- **Why:** streaming WER 8.4% → 6.84% at latency parity. No trade-off to weigh.
- **Worth remembering:** for a while the pipeline ran nova-2 while the cost table
  billed nova-3 *and the tests asserted nova-3* — so the dashboard was
  confidently wrong and the test that claimed to catch it passed anyway, because
  it compared two hardcoded strings. That bug is why `models.py` exists.

### ~~ElevenLabs `eleven_turbo_v2_5`~~
**Superseded. Replaced by: `eleven_flash_v2_5`.**

- **Why:** ElevenLabs deprecated the Turbo line; their guidance is to use Flash
  over Turbo in all cases. Same voices, same price, lower first-byte latency.

### ~~HR / recruiter flow, candidate-invite flow, and the legacy single-agent flow~~
**Superseded. Removed entirely.**

- **Was:** an HR route group (templates → invite tokens → candidate review), a
  candidate invite-redemption flow, and the original single-agent
  `interviews`/`feedback` flow.
- **Why it was reversed:** the product is a practice tool. Multi-tenant hiring
  surfaces were scope that nothing in the current product uses, and dead
  route groups are a maintenance and security cost (they're still deployed).
- **Residue:** `templates.hrUid` (now just "who owns this template"),
  `sessions.inviteToken: "practice"` as a sentinel, and
  `lib/role-resolution.ts` + `lib/admin-claims.ts`, which are no longer called
  from app code.
