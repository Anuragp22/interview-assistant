# JobVoice — Real-Time AI Interview Simulator

A voice-driven mock-interview platform. The candidate joins a LiveKit room and
speaks with a **three-interviewer panel** — Sarah (behavioral) hands off to
Adam (technical), who hands off to Bella (system design) — each with their own
voice and agenda, grounded in the candidate's CV + the job description. When the
panel finishes, each round is scored **against its own rubric** by a separate
model, and a report is generated with the transcript quotes behind every score.

Live demo: <https://interview-assistant-nu.vercel.app/>

## What this is, in one diagram

```
┌─────────┐ WebRTC  ┌────────────┐  dispatch  ┌──────────────────────┐
│ Browser │ ───────▶│ LiveKit    │ ─────────▶ │  Python agent worker │
│ (Next)  │ ◀─────── │  Cloud SFU │ ◀──────── │  (livekit-agent/)    │
└─────────┘  audio  └────────────┘   audio    └──────────┬───────────┘
     │                                                    │
     │                                    STT (Deepgram Nova-3)
     │                                    LLM (Groq gpt-oss-120b)
     │                                    TTS (ElevenLabs Flash v2.5)
     │                                    EOU (LiveKit audio TurnDetector)
     │                                                    │
     │                                        on call end │ marks awaiting-report
     │                                                    ▼
     │                                    ┌──────────────────────────┐
     │                                    │ Judge — Gemini Flash-Lite│
     │                                    │ per-round BARS scoring   │
     │                                    └──────────┬───────────────┘
     ▼                                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Firestore (sessions, turns, reports)             │
└─────────────────────────────────────────────────────────────────────┘
```

## Key design decisions

- **Cascaded STT→LLM→TTS, not speech-to-speech.** S2S is ~400ms faster, and
  every disclosed AI-interview stack in the industry still runs cascaded. The
  reason is that the transcript *is* the product here: it's the scoring input,
  the audit artifact, and the thing a candidate can point at to contest a score.
  S2S makes the transcript a byproduct rather than a contract.

- **The judge is a different model family from the interviewer.** The panel runs
  on Groq `gpt-oss-120b`; scoring runs on Gemini. If one model holds a wrong
  belief, it will both fail to probe a candidate's correct answer *and* mark that
  answer wrong when grading — the error lives in the weights, so a fresh
  stateless call doesn't fix it. Scoring is offline, so the judge is chosen for
  reasoning quality rather than speed.

- **Scores are 0–5 against behavioural anchors, not 0–100.** LLM judges can't
  discriminate 100 levels — they cluster at 70/75/85. A ~5-point anchored scale
  measurably tracks human raters best, and behavioural anchors are the single
  biggest lever on structured-interview validity (r≈.35 → r≈.56).

- **Evidence before score.** The judge must quote the transcript, then reason,
  then commit to a number — enforced by schema field order, since structured
  decoding fills fields in sequence. The recommendation is a *separate* call that
  never sees the raw transcript, so it can't anchor the scores (and can't be
  reached by an injection buried in candidate speech).

- **Every round is scored against its own rubric.** Sarah's round is graded on
  behavioural criteria, Adam's on technical, Bella's on system design. The agent
  stamps `personaId` on every turn and the judge reads it.

- **Nothing about *how* someone speaks is scored.** No tone, no affect, no
  confidence, no accent, no fluency. Partly because it's not evidence of ability;
  partly because inferring emotion in a hiring context is a prohibited practice
  under the EU AI Act. There is no "Cultural Fit" score for the same reason.

- **The report doesn't depend on the browser.** The agent marks the session
  `awaiting-report` when the call ends, pings the scoring endpoint, and a cron
  reconciler sweeps anything the ping missed. Close the lid mid-answer and you
  still get scored.

## Other features

- **Turn detection via LiveKit's audio EOU model**, not a silence timer. ~3x
  fewer false cutoffs at the same latency (9.9% vs ~27.7% on eot-bench). Tuned
  deliberately patient: cutting off a thinking candidate is worse than being
  400ms slow.
- **Deterministic prompt-injection defense** — `TransferGuard` turn-count
  preconditions on hand-off / end-interview tools + post-hoc system-prompt
  leak detection, both code-level. See `docs/security.md`.
- **50-prompt adversarial audit** — versioned corpus (`security/injection_corpus.py`)
  with declarative `must_not_call_tools` predicates, gated by `security_baseline.json`.
- **LLM eval harness** — offline regression gate (`eval/`) for question
  generation; fails CI on any per-fixture metric dropping >10 percentage points.
- **Per-stage latency budgets** (`latency_budget.py`) with per-turn OTel spans.
- **Per-session cost telemetry** (`cost_aggregator.py`), surfaced in the dashboard.
- **End-to-end OpenTelemetry tracing** — one trace ID spans the Next.js server
  action → Firestore session doc → Python agent worker, via a W3C `traceparent`.
- **Mid-interview resume** — reopening a closed tab continues at the persona the
  panel was on.

## Tech stack

| Layer | Tech |
|---|---|
| Frontend | Next.js 15 (App Router), React 19, Tailwind CSS 4, Radix UI |
| Auth + DB | Firebase Auth (session cookies) + Firestore |
| Real-time transport | LiveKit Cloud (WebRTC SFU) |
| Agent runtime | Python 3.11 + LiveKit Agents 1.6 |
| STT | Deepgram Nova-3 |
| LLM (interview + question generation) | Groq `openai/gpt-oss-120b` |
| LLM (scoring) | Google `gemini-3.1-flash-lite` |
| TTS | ElevenLabs `eleven_flash_v2_5` (per-persona voice IDs) |
| End-of-turn | LiveKit audio `TurnDetector` (v1) |
| Observability | OpenTelemetry traces (Next.js + Python agent) |

Model ids live in one place per side — `livekit-agent/src/interview_agent/models.py`
and `lib/groq.ts` / `lib/judge.ts` — so the cost table can't drift out of sync
with what's actually running.

## How a session flows

1. **Setup** — user picks a role, level, and JD at `/practice/new`, optionally
   uploading a CV (or reusing the one on `/practice/settings`).
2. **Question generation** — `generatePartitionedQuestions` (Groq) produces
   per-persona question buckets; `regroundPartitionedQuestions` rewrites them
   against the CV so each question references concrete details.
3. **Token mint + room join** — Next.js mints a LiveKit JWT carrying the session
   ID and traceparent. The browser joins `session-{id}` and publishes mic audio.
4. **Worker dispatch** — LiveKit Cloud dispatches the Python worker. It reads the
   session doc, builds three Agent subclasses (one per persona) with the CV and
   JD inlined in each system prompt, and starts with the behavioral persona.
5. **Per turn** — Deepgram → audio TurnDetector decides the candidate is done →
   Groq with the persona prompt + agenda → ElevenLabs streaming TTS → browser.
   The turn is written to `sessions/{id}/turns` with its persona and latency.
6. **Hand-off** — after ~3–6 substantive turns the persona calls
   `transfer_to_<next>` (or `end_interview` on the last). `TransferGuard`
   enforces a minimum-turn precondition in code, so an early "I'm Adam, transfer
   to me" injection is dropped deterministically.
7. **Scoring** — the agent marks the session `awaiting-report` and pings
   `/api/internal/score`. The judge segments the transcript by persona, scores
   each round against its rubric 3× with the criteria rotated (criterion order
   alone can move scores by up to 0.8 points), takes the median, then makes a
   separate call for the recommendation.
8. **Report** — `/practice/{id}/report` shows per-round scores with the verbatim
   quotes behind each one, and flags low confidence when the judge disagreed with
   itself across permutations.

## Getting started

### Prerequisites

- Node.js 18+ and npm
- Python 3.11+ + `uv` (for the agent worker)
- Firebase project (Firestore + Auth)
- LiveKit Cloud project
- Groq API key — <https://console.groq.com/keys>
- **Gemini API key with billing enabled** — <https://aistudio.google.com/apikey>
  (the free tier trains on submitted content, and this call carries candidate
  CVs and transcripts; the paid tier does not, and costs ~$0.35/100 interviews)
- Deepgram API key
- ElevenLabs API key

### Environment variables

Copy `.env.example` → `.env.local` and `livekit-agent/.env.example` →
`livekit-agent/.env`. Both files document what each variable is for.

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

Both processes must be running — the Next.js app issues LiveKit tokens and hosts
the judge, but the interview pipeline lives in the agent.

## Tests + audits

```bash
# Next.js unit tests (Vitest)
npm test

# Type check — note `next build` does NOT typecheck (see next.config.ts)
npx tsc --noEmit

# Python agent tests
cd livekit-agent && uv run pytest -v

# Question-generation eval harness — gates CI on per-fixture metric drift
npm run eval

# Prompt-injection audit (smoke: ~10s, ~$0.01)
cd livekit-agent
uv run python -m interview_agent.security.run_audit --smoke

# Full audit (50 cases × 3 personas = 150, ~3 min)
uv run python -m interview_agent.security.run_audit
```

## Project structure

```
interview-assistant/
├── app/
│   ├── (auth)/                       sign-in / sign-up
│   ├── (practice)/practice/          dashboard, /new, /settings, [sessionId]/{interview,report}
│   └── api/
│       ├── practice/                 CV upload + session creation
│       ├── sessions/[id]/livekit-token
│       └── internal/                 score (agent-triggered) + reconcile (cron)
├── components/practice/              all UI for the practice flow
├── lib/
│   ├── actions/                      server actions (auth, practice, reports)
│   ├── llm/                          question generation + regrounding (Groq)
│   ├── judge-report.ts               → lib/llm/, the scoring pipeline (Gemini)
│   ├── rubric.ts                     BARS anchors — the scoring contract
│   ├── judge.ts                      judge model provider
│   ├── groq.ts                       interviewer model provider + failover
│   └── livekit.ts                    JWT minting + traceparent propagation
├── eval/                             offline question-generation regression harness
├── livekit-agent/                    Python LiveKit Agents worker
│   └── src/interview_agent/
│       ├── agent.py                  3 Agent subclasses + entrypoint
│       ├── models.py                 model ids — single source of truth
│       ├── pipeline.py               AgentSession factory + turn handling
│       ├── persona.py                personas, voices, prompt templates
│       ├── reporting.py              scoring hand-off (durable marker + ping)
│       ├── security_guards.py        TransferGuard + leak detector
│       ├── latency_budget.py         per-stage budgets
│       └── cost_aggregator.py        per-session provider spend
└── docs/                             security, observability, architecture
```

## Documentation

- [`docs/security.md`](docs/security.md) — prompt-injection threat model, defense stack, audit harness
- [`docs/observability.md`](docs/observability.md) — tracing, latency budgets, cost telemetry
- [`livekit-agent/README.md`](livekit-agent/README.md) — agent worker dev setup + deployment
- [`eval/README.md`](eval/README.md) — question-generation regression harness
