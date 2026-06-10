# TECH DECISIONS - JobVoice / Interview Assistant

> **Docs set:** [Index](README.md) · [Architecture](ARCHITECTURE.md) · Tech Decisions · [Glossary](GLOSSARY.md) · [Interview Prep](INTERVIEW_PREP.md) | deep dives: [security](security.md) · [observability](observability.md) · [resume](resumable-sessions.md)

> Every framework, library, provider, and pattern in the codebase: what it does, and the
> *likely* reason it was chosen over alternatives.
>
> **Rule:** where the code or its comments state a rationale, it's cited. Where the rationale
> is a reasonable inference but not written down, it's tagged **[ASSUMED]** - say so honestly
> in an interview. Versions are from `package.json` and `livekit-agent/pyproject.toml`.

---

## 1. Frameworks & runtime

### Next.js 15 (App Router, Turbopack) - `package.json` `next ^15.2.4`
- **Does:** React framework; App Router with route groups, Server Actions, and Route
  Handlers; renders the UI and hosts the server tier.
- **Why this / over alternatives:** Server Actions + Route Handlers keep all secrets
  (LiveKit API secret, Groq key, Firebase Admin cert) server-side while colocating them with
  the UI. The LiveKit-JWT-mint is explicitly a server action so the secret never reaches the
  browser (`ONBOARDING.md:175`). Over a separate Express/Nest backend: one deploy target,
  no CORS, typed end-to-end. **[ASSUMED]** for the React-framework choice itself.

### React 19 + TypeScript 5 - `react ^19.0.0`, `typescript ^5`
- **Does:** UI rendering; static typing across client + server.
- **Why:** Latest React for `use`/Server Components support in App Router. TypeScript gives
  the shared **ambient domain types** (`types/index.d.ts`) that both client and server rely
  on without imports. **[ASSUMED]**.

### Python 3.11 + LiveKit Agents 1.5 - `livekit-agent/pyproject.toml` (`livekit-agents>=1.5,<2`)
- **Does:** The voice-agent runtime - connects to a LiveKit room, runs the STT→LLM→TTS
  pipeline, manages the agent lifecycle, forks a subprocess per job.
- **Why this / over alternatives:** This is the **load-bearing reason the system is two
  services**. The mature voice-agent + plugin ecosystem (Deepgram, ElevenLabs, Silero,
  OpenAI-compatible LLM) is Python-native, and the pipeline is a long-lived, stateful,
  audio-streaming process that cannot run in a serverless Next.js function. The native
  multi-agent hand-off pattern (`@function_tool` returning an `Agent`) is used directly
  (`agent.py:13-20`). Over building voice orchestration from raw WebRTC: enormous.

---

## 2. Real-time transport & voice providers

### LiveKit Cloud (WebRTC SFU) - `livekit-client ^2.18.9`, `livekit-server-sdk ^2.15.2`
- **Does:** Carries bidirectional audio between browser and agent; auto-dispatches the
  registered Python worker into the room on participant join; provides a data channel for
  transcript/status messages.
- **Why:** WebRTC SFU is the right tool for low-latency, full-duplex voice (vs. raw
  websockets or HTTP streaming). LiveKit Cloud also gives the **dispatch model** that lets
  the browser start an interview without the Next.js server holding an agent connection
  (`agent.py:748-752`). Token minting via `livekit-server-sdk` (`lib/livekit.ts`).

### Deepgram Nova-2 (STT) - `livekit-plugins-deepgram`
- **Does:** Streaming speech-to-text. Actual runtime config:
  `deepgram.STT(model="nova-2", language="en-US")` (`pipeline.py:77`).
- **Why:** Best-class low-latency streaming WS STT (`latency_budget.py:24` calls it
  "best-class on-prem WS"). **Note the drift:** the cost calculator and the latency-budget
  doc-comment say **nova-3** (`cost_rates.py:10,28`, `latency_budget.py:24`) while the
  pipeline runs **nova-2** - flagged in `INTERVIEW_PREP.md` weaknesses.

### Groq `llama-3.3-70b-versatile` (LLM) - `@ai-sdk/groq ^3.0.39` (web), `livekit-plugins-openai` (agent)
- **Does:** All language generation - interview replies (agent), question generation +
  grounding + report scoring (Next.js).
- **Why this / over alternatives:** **Latency.** A voice interview is bottlenecked on LLM
  time-to-first-token; the budget file cites "Groq publishes 80-150ms TTFT for warm
  requests" (`latency_budget.py:62-70`) - Groq's LPU inference is dramatically faster TTFT
  than typical GPT-4-class hosted models, which is the single biggest lever on perceived
  conversational latency. The agent reaches Groq through `livekit-plugins-openai` against
  Groq's **OpenAI-compatible** endpoint (`pipeline.py:30`,
  `GROQ_BASE_URL="https://api.groq.com/openai/v1"`), so no custom client is needed. Llama-3.3
  70B is the quality/speed sweet spot offered by Groq. Trade-off: Groq doesn't support strict
  `json_schema` output - see the json_object pattern below.

### ElevenLabs `eleven_turbo_v2_5` (TTS) - `livekit-plugins-elevenlabs`
- **Does:** Per-persona streaming text-to-speech; each persona has a distinct premade
  voice ID and `VoiceSettings`. (`persona.py:130-179`, `agent.py:174-199`)
- **Why:** High-quality, low-latency streaming voices, and **distinct voices per persona**
  are core to selling the "panel" illusion. `streaming_latency=3` opts into the "max latency
  optimization" profile while keeping text normalization on (4 would risk mispronouncing
  numbers/abbreviations) - an explicit, reasoned tuning choice (`agent.py:183-188`).

### Silero VAD - `livekit-plugins-silero`
- **Does:** Voice-activity detection (when is the candidate speaking / done). Pre-loaded
  once per worker in `prewarm` (`agent.py:755-768`).
- **Why:** Standard local VAD for endpointing; running it locally avoids an extra network
  round-trip in the turn loop. **[ASSUMED]** for the specific choice.

### Turn-taking is tuned, not default - `pipeline.py:88-106`
- **Does:** the session passes a custom `turn_handling` dict: interruption `min_duration=1.0`
  AND `min_words=3`, `endpointing.min_delay=0.8`, `false_interruption_timeout=2.0`.
- **Why:** LiveKit defaults (0.5s / 0 words / 0.5s) cut candidates off on filler sounds
  ("uh"/"mm") and jumped in during thinking pauses (commit `d3525d4`). TTS is deliberately
  **not** on the session - each `Agent` owns its voice so a hand-off changes the voice.
  `GROQ_API_KEY` is validated at session construction and raises there, so a misconfigured
  worker fails fast on dispatch, not mid-call (`pipeline.py:42-47`).

---

## 3. AI / retrieval libraries

### Vercel AI SDK (`ai ^6.0.175`) + `@ai-sdk/groq`
- **Does:** `generateObject()` with a Zod schema for structured LLM output on the Next.js
  side (question gen, grounding, report).
- **Why:** Gives schema-validated structured generation with one call. **Key constraint
  handled explicitly:** Llama-3.3 doesn't support strict `json_schema` mode, so the code uses
  `providerOptions: { groq: { structuredOutputs: false } }` (json_object mode), puts the
  literal word "JSON" in the prompt, and describes the shape inline; the SDK then validates
  against the Zod schema client-side (`lib/llm/groq-template.ts:13-33,40-70`). This is a
  documented work-around, not an accident.

### LlamaIndex + FastEmbed `BAAI/bge-small-en-v1.5` - `llama-index-core>=0.13,<0.14`, `llama-index-embeddings-fastembed`, `fastembed`
- **Does:** Builds a per-session in-memory `VectorStoreIndex` over the CV + JD; powers the
  `lookup_cv_jd` and `verify_cv_claim` tools. (`rag.py`)
- **Why this / over alternatives:** **FastEmbed BGE-small is CPU-only, needs no API key, and
  is ~50ms/chunk** (`rag.py:7-10`) - no embedding-provider dependency or per-call cost, and
  the model is **prewarmed at worker startup** so the first session doesn't pay the ~3s load
  (`rag.py:65-74`, `agent.py:755-768`). Over a hosted vector DB (Pinecone/pgvector): the
  corpus is *one CV + one JD per session*, so an in-memory index is simpler and faster than
  any network-backed store. `llama-index-core` is pinned `>=0.13` specifically to fix
  `GHSA-cr7q-2w66-hjcm` (`pyproject.toml` comment; git `b500fde`).
- **Clever bit:** `verify_cv_claim` bins cosine similarity into **supported (≥0.55) /
  ambiguous (0.40-0.55) / unsupported (<0.40)** and returns a *natural-language* verdict
  string (not a dict) so it streams cleanly through the chat-completion tool surface
  (`rag.py:21-62,124-167`).

---

## 4. Auth & data

### Firebase Auth (session cookies + custom claims) - `firebase ^11.4.0`, `firebase-admin ^13.2.0`
- **Does:** Client signs in → ID token → server exchanges it for a 7-day **session cookie**
  via Admin SDK; **custom claims** carry `role: "hr" | "candidate"`.
  (`lib/actions/auth.action.ts`, `lib/admin-claims.ts`)
- **Why:** Session cookies (httpOnly) keep auth server-verifiable on every request without
  shipping a long-lived token to JS; custom claims ride in the ID token for fast role checks
  (`role-resolution.ts` reads the claim first, falls back to Auth lookup). **[ASSUMED]** for
  picking Firebase over Auth.js/Clerk - consistent with pairing it with Firestore for
  zero-ops.
- **Gotcha encoded in code:** `FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n")` normalizes the
  escaped-newline env-var (`firebase/admin.ts`) - the single most common setup failure.

### Firestore (NoSQL document DB)
- **Does:** The cross-service state + authorization spine (see `ARCHITECTURE.md` §8).
- **Why this / over alternatives:** Real-time, serverless, security-rules at the edge, and
  **the same DB is reachable from both Next.js (Admin SDK) and the Python agent
  (service-account)** - a relational DB would need a shared connection layer. Security rules
  enforce ownership and make all core-collection writes server-only (`allow write: if false`,
  `firestore.rules`). Trade-off: no joins (the code does in-memory joins, e.g.
  `getPracticeHistory`) and no composite-index requirement is avoided by single-field queries
  + in-memory sort. **[ASSUMED]** on the relational-vs-document choice.

---

## 5. UI / forms / styling

| Library | Version | Does | Likely why |
|---|---|---|---|
| Tailwind CSS 4 | `tailwindcss ^4` | Utility-first styling; token-driven dark design system in `app/globals.css` | Fast iteration; the design system uses CSS custom-property tokens (`surface-*`, `accent`, etc.) - `ONBOARDING.md:181`. **[ASSUMED]** |
| Radix UI | `@radix-ui/react-label`, `react-slot` | Accessible primitives behind shadcn-style components in `components/ui/` | Standard shadcn stack; accessibility for free. **[ASSUMED]** |
| `class-variance-authority`, `clsx`, `tailwind-merge` | - | Variant + className composition (the `cn()` helper) | Canonical shadcn tooling. **[ASSUMED]** |
| React Hook Form + Zod | `react-hook-form ^7`, `@hookform/resolvers ^4`, `zod ^3.24.2` | Form state + schema validation (auth, template, practice forms) | One Zod schema validates both the form *and* the LLM output shape - schema reuse. (`AuthForm.tsx`, `constants/index.ts`) |
| `sonner` | `^2` | Toast notifications | Lightweight; used to surface action failures. **[ASSUMED]** |
| `lucide-react`, `next-themes` | - | Icons; theme switching | Standard. **[ASSUMED]** |
| `dayjs` | `^1.11` | Date formatting | Small footprint vs moment. **[ASSUMED]** |
| `mammoth`, `unpdf` | `^1.12`, `^1.6` | Extract text from DOCX / PDF CVs (`lib/cv-parse.ts`) | Pure-JS extraction so CV parsing runs in the Next.js runtime without a service; text is capped at 50KB to bound LLM context (`practice.action.ts`). |

---

## 6. Observability stack

| Library | Where | Does | Why |
|---|---|---|---|
| `@vercel/otel`, `@opentelemetry/*` | Next.js (`instrumentation.ts`, `lib/tracing.ts`) | Emit spans for server actions + LLM calls; generate the W3C `traceparent` | Standard OTel; vendor-neutral, exports to any OTLP endpoint (Honeycomb headers supported) |
| `opentelemetry-{api,sdk,exporter-otlp-proto-http}` | Python agent (`tracing.py`) | Continue the same trace; emit `agent.*`, `rag.*`, `agent.turn-latency`, `session.cost` spans | **Cross-process trace continuity** - the agent rehydrates the Next.js `traceparent` so one trace covers create→interview→report |
| Custom `JSONLSpanExporter` | `tracing.py` | Dump spans as JSONL for offline replay | Lets `eval/latency-report.ts` compute p50/p95/p99 without a tracing backend |

**Why OTel at all (vs. logs):** the system is distributed across browser → Next.js →
Firestore → LiveKit → Python; a single trace ID is the only way to follow one interview
end-to-end. Full design: `docs/observability.md`.

---

## 7. Testing & quality-gate tooling

| Tool | Scope | What it gates |
|---|---|---|
| **Vitest** `^4.1.6` | Next.js - 3 files, ~31 cases (`tests/schemas`, `role-resolution`, `cost-rates`) | Zod schema validity, role-resolution logic, cost-rate math (incl. that the TS + Python rates agree) |
| **pytest** | Python agent - 13 modules, **127 tests** (verified: `uv run pytest` -> 127 passed) | Personas, hand-off, `TransferGuard`, leak detection, latency budgets, cost, resume, persistence, RAG, tracing |
| **Eval harness** (`eval/run.ts`, `tsx`) | Question generation - **10 hand-curated (CV, JD) fixtures**, **4 weighted deterministic scorers** (cvGrounding 0.35, partitionCorrectness 0.30, hallucinationGuard 0.20, schemaPass 0.15; no LLM-as-judge), `baselines.json` (`eval/scorers.ts`) | Fails when any per-fixture metric drops > 10 percentage points vs baseline |
| **Injection audit** (`security/run_audit.py`) | Security - **50 cases × 3 personas = 150**, declarative predicates, regression vs a generated baseline | Catches prompt-injection regressions against the real rendered prompt |
| **mypy / ruff** | Python | caches present (`.mypy_cache`, `.ruff_cache`) - static typing + lint |

- **Why deterministic scorers over LLM-as-judge** (`eval/scorers.ts`): reproducible,
  zero-cost, no judge-model variance - the harness can run in CI as a hard gate.
- **Why per-persona buckets in the audit + a baseline file:** distinguishes *new* failures
  from known-acceptable ones; the baseline (`security_baseline.json`) is **generated locally**
  via `--baseline`, not committed.

---

## 8. Build / deploy / tooling

| Thing | Choice | Why |
|---|---|---|
| Package manager (Python) | `uv` (pinned `0.11.15` in Docker) | Fast, reproducible; git `44936b7` pins it for the "Silver" static-check submission |
| Container | Root `Dockerfile` + `livekit-agent/Dockerfile` | Deploy the worker (README mentions Render / Fly.io); root Dockerfile added for a submission harness (git `50a8ca4`) |
| `tsx` | run TS scripts (`eval/run.ts`, `latency-report.ts`) directly | No build step for tooling scripts |
| Dependabot bumps | visible in git (`b500fde`, `a0705f2`) | Security hygiene - transitive CVE fixes |

---

## 9. Cross-cutting patterns (the "why it's not a typical CRUD app")

1. **Security-in-code, not security-in-prompt.** Deterministic `TransferGuard` preconditions
   + post-hoc leak detection; the prompt rule is explicitly "belt-and-suspenders"
   (`security_guards.py:1-35`, `persona.py:14-24`). An ML classifier was tried and
   *removed* in favor of this (git `c6bfe0d`).
2. **Two-phase, partitioned LLM generation.** Phase 1 generates per-role questions; Phase 2
   re-grounds them against the specific CV; both partitioned into behavioral/technical/
   system-design buckets (3 each = 9). (`lib/llm/groq-template.ts`, `groq-grounding.ts`)
3. **Schema as the single source of truth.** Zod schemas in `constants/index.ts` validate
   LLM output, forms, and the Firestore round-trip; the Python `Turn`/`CostBreakdown`
   dataclasses mirror the same camelCase shapes via `to_firestore_dict()`
   (`cost_rates.py:48-57`).
4. **Doc as contract, mirrored by hand.** `types/livekit.d.ts` mirrors the Python
   `messages` envelope; `lib/cost-rates.ts` mirrors `cost_rates.py`; both have "keep in sync"
   comments because there's no codegen (a deliberate, acknowledged trade-off).
5. **Prewarm everything model-shaped.** Silero VAD (~200ms) and FastEmbed (~3s) load once
   per worker in `prewarm`, not mid-call (`agent.py:755-768`).
6. **Idempotent, crash-safe teardown.** Cost rollup runs in a `finally` even on error paths
   so a crashed session still records partial spend; `finalize()` is idempotent
   (`agent.py:710-740`).
7. **Module-globals-per-subprocess.** Relies on LiveKit forking one subprocess per job to
   make module-level state session-scoped (`agent.py:91-127`) - pragmatic, with a real
   trade-off (see `INTERVIEW_PREP.md`).
