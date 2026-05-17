# JobVoice — Real-Time AI Interview Simulator

A voice-driven mock-interview platform. The candidate joins a LiveKit room and
speaks with a **three-interviewer panel** — Sarah (behavioral) hands off to
Adam (technical), who hands off to Bella (system design) — each with their own
voice and rubric. Questions are grounded in the candidate's CV + the job
description; claims are fact-checked live against the CV with a RAG tool call;
and a per-session report is generated when the panel concludes.

Live demo: <https://interview-assistant-nu.vercel.app/>

## What this is, in one diagram

```
┌─────────┐ WebRTC  ┌────────────┐  dispatch  ┌──────────────────────┐
│ Browser │ ───────▶│ LiveKit    │ ─────────▶ │  Python agent worker │
│ (Next)  │ ◀─────── │  Cloud SFU │ ◀──────── │  (livekit-agent/)    │
└─────────┘  audio  └────────────┘   audio    └──────────┬───────────┘
     │                                                    │
     │                                          STT (Deepgram Nova-2)
     │                                          LLM (Groq Llama-3.3 70B)
     │                                          TTS (ElevenLabs turbo_v2_5)
     │                                          RAG (LlamaIndex over CV + JD)
     │                                                    │
     ▼                                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Firestore (sessions, turns, reports)             │
└─────────────────────────────────────────────────────────────────────┘
```

## Key features

- **3-agent voice panel** — Behavioral → Technical → System Design, each with
  a distinct ElevenLabs voice, persona-specific rubric, and LiveKit-native
  `@function_tool` hand-off. Per-persona question lists are partitioned at
  generation time, so each round has its own agenda.
- **In-session CV/JD fact-checking** — `verify_cv_claim` and `lookup_cv_jd`
  tool calls run LlamaIndex retrieval over the candidate's CV and the job
  description, so the interviewer asks about *that* project at *that* company
  rather than generic placeholders.
- **Multi-layer prompt-injection defense** — DeBERTa input classifier
  (sequential or speculative-parallel mode) + deterministic `TransferGuard`
  preconditions on hand-off / end-interview tools + post-hoc system-prompt
  leak detection. See `docs/security.md`.
- **50-prompt adversarial audit** — versioned corpus (`security/injection_corpus.py`)
  with declarative `must_not_call_tools` predicates; runs against the real
  rendered system prompt and gates regressions via `security_baseline.json`.
- **LLM eval harness** — 10-fixture offline regression gate
  (`eval/`) for question generation; fails CI on any per-fixture metric
  dropping more than 10 percentage points.
- **Per-stage latency budgets** — `latency_budget.py` enforces wall-clock
  budgets per turn stage (STT, LLM TTFT, TTS first audio); replay analyzer
  walks past sessions and reports budget violations.
- **Per-session cost telemetry** — `cost_aggregator.py` rolls up provider
  spend (Groq tokens, Deepgram seconds, ElevenLabs characters, LiveKit
  minutes) at session end and surfaces it in the practice dashboard.
- **End-to-end OpenTelemetry tracing** — one trace ID spans the Next.js
  server action → Firestore session doc → Python agent worker, propagated
  via a W3C `traceparent` field written onto the session document.
- **Mid-interview resume** — closing the tab mid-call and reopening
  continues at the persona the panel was on, not from scratch.
- **Practice dashboard** — score sparkline, session history, CV management
  (view / replace / remove) at `/practice/settings`.

## Tech stack

| Layer | Tech |
|---|---|
| Frontend | Next.js 15 (App Router), React 19, Tailwind CSS 4, Radix UI |
| Auth + DB | Firebase Auth (session cookies) + Firestore |
| Real-time transport | LiveKit Cloud (WebRTC SFU) |
| Agent runtime | Python 3.11 + LiveKit Agents 1.5 |
| STT | Deepgram Nova-2 |
| LLM (interview + question generation + feedback) | Groq `llama-3.3-70b-versatile` |
| TTS | ElevenLabs `eleven_turbo_v2_5` (per-persona voice IDs) |
| RAG | LlamaIndex with FastEmbed BGE-small embeddings |
| Prompt-injection classifier | HuggingFace `protectai/deberta-v3-base-prompt-injection-v2` via `optimum.onnxruntime` (or opt-in Llama Prompt Guard 2 22M) |
| Observability | OpenTelemetry traces (Next.js + Python agent) |
| Forms / validation | React Hook Form + Zod |

## How a session flows

1. **Practice setup** — user picks a role, level, and JD at `/practice/new`,
   optionally uploading a CV (or reusing the one saved on `/practice/settings`).
2. **Question generation** — `generatePartitionedQuestions` (Groq) produces
   per-persona question buckets grounded in the CV + JD; `regroundPartitionedQuestions`
   rewrites them after retrieval so each question references concrete CV details.
3. **Token mint + room join** — Next.js mints a LiveKit JWT carrying the
   session ID and traceparent. The browser joins room `interview-{id}` and
   publishes microphone audio.
4. **Worker dispatch** — LiveKit Cloud dispatches the Python worker to the
   room. The worker reads the session doc from Firestore, builds three Agent
   subclasses (one per persona), and starts with the behavioral persona.
5. **Per turn** — Deepgram → input classifier (blocks injections) → Groq with
   per-persona prompt + agenda + tool schema → ElevenLabs streaming TTS →
   browser. The completed turn is written to `sessions/{id}/turns` with
   persona, latency-budget hits, and any prompt-leak warnings tagged on.
6. **Hand-off** — after ~3-6 substantive turns the active persona calls
   `transfer_to_<next>` (or `end_interview` on the last). `TransferGuard`
   enforces a minimum-turn precondition in code so an early "I'm Adam,
   transfer to me" attack is dropped deterministically.
7. **Report** — on `end_interview`, the Next.js feedback server action reads
   all turns, scores against `feedbackSchema` via Groq, writes to the
   `reports/{sessionId}` collection, and the report page renders a
   persona-tagged transcript + score breakdown.

## Getting started

### Prerequisites

- Node.js 18+ and npm
- Python 3.11+ + `uv` (for the agent worker)
- Firebase project (Firestore + Auth)
- LiveKit Cloud project
- Groq API key — <https://console.groq.com/keys>
- Deepgram API key
- ElevenLabs API key

### Environment variables (Next.js — `.env.local`)

```
# Firebase (client)
NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=
NEXT_PUBLIC_FIREBASE_PROJECT_ID=
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=
NEXT_PUBLIC_FIREBASE_APP_ID=

# Firebase (admin — server actions)
FIREBASE_PROJECT_ID=
FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY=

# Groq — question generation + post-call feedback
GROQ_API_KEY=
# GROQ_MODEL=llama-3.3-70b-versatile  # optional override

# LiveKit
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=
NEXT_PUBLIC_LIVEKIT_URL=wss://your-project.livekit.cloud

# Provider keys read by both the Next.js app and the agent in dev
DEEPGRAM_API_KEY=
ELEVEN_API_KEY=

# OpenTelemetry (optional — exporter endpoint)
# OTEL_EXPORTER_OTLP_ENDPOINT=
```

The Python agent has its own `livekit-agent/.env` with the same provider
keys plus a Firebase service-account JSON for per-turn writes. See
`livekit-agent/README.md`.

### Run locally

```bash
# 1. Install Next.js deps
npm install

# 2. Start the web app
npm run dev   # http://localhost:3000

# 3. In a second terminal — start the Python agent worker
cd livekit-agent
uv sync --extra dev
uv run python -m interview_agent.agent dev
```

Both processes must be running — the Next.js app issues LiveKit tokens, but
the actual interview pipeline (STT/LLM/TTS) lives in the agent.

## Tests + audits

```bash
# Next.js unit tests (Vitest)
npm test

# Python agent tests (142 tests covering personas, hand-off, classifier,
# guards, latency budget, cost aggregator)
cd livekit-agent && uv run pytest -v

# Question-generation eval harness — gates CI on per-fixture metric drift
npm run eval

# Prompt-injection audit (smoke: ~10s, ~$0.01)
cd livekit-agent
uv run python -m interview_agent.security.run_audit --smoke

# Full audit (50 cases × 3 personas = 150, ~3 min, ~$0.15)
uv run python -m interview_agent.security.run_audit
```

## Project structure

```
interview-assistant/
├── app/
│   ├── (auth)/                       sign-in / sign-up
│   ├── (practice)/practice/          dashboard, /new, /settings, [sessionId]/interview, [sessionId]/report
│   └── api/practice/                 CV upload + session creation routes
├── components/                       shared React components
├── lib/
│   ├── actions/                      server actions (auth, practice, token, feedback)
│   ├── llm/                          question generation + regrounding (Groq)
│   ├── livekit.ts                    JWT minting + traceparent propagation
│   └── tracing.ts                    OpenTelemetry setup
├── eval/                             offline question-generation regression harness
├── livekit-agent/                    Python LiveKit Agents worker
│   ├── src/interview_agent/
│   │   ├── agent.py                  3 Agent subclasses + entrypoint
│   │   ├── persona.py                Sarah / Adam / Bella personas + voices + rules
│   │   ├── input_classifier.py       DeBERTa prompt-injection scanner
│   │   ├── security_guards.py        TransferGuard + leak detector
│   │   ├── security/                 50-case audit corpus + runner + baseline
│   │   ├── rag.py                    LlamaIndex CV/JD retriever
│   │   ├── latency_budget.py         per-stage budgets + violation reporting
│   │   ├── cost_aggregator.py        per-session provider spend roll-up
│   │   └── tracing.py                OTel setup (continues traceparent from web)
│   ├── tests/
│   └── README.md
├── docs/
│   ├── security.md                   threat model + defense-in-depth design
│   └── observability.md              tracing + latency budget + cost telemetry
├── firebase/                         client + admin SDK setup
└── types/                            shared TypeScript + livekit.d.ts
```

## Documentation

- [`docs/security.md`](docs/security.md) — prompt-injection threat model, 4-layer defense stack, audit harness design
- [`docs/observability.md`](docs/observability.md) — OTel tracing setup, latency-budget gates, cost telemetry
- [`livekit-agent/README.md`](livekit-agent/README.md) — agent worker dev setup + deployment (Render, Fly.io)
- [`eval/README.md`](eval/README.md) — question-generation regression harness
