# JobVoice — Panel-Pressure Interview Simulator

The only place to practice being grilled by a multi-interviewer panel. The
candidate picks a **panel preset** (big-tech loop, early-startup, new-grad) and
an **intensity** — Calm, Standard, or **Grill**, where interviewers interject,
cross-examine, and openly disagree — then joins a LiveKit room and talks to the
panel: one AI agent roleplaying every interviewer, each speaking in their own
voice, grounded in the candidate's CV + the job description. When the panel
finishes, each round is scored **against its own rubric** by a separate model,
and the report answers the question a prep user actually has: *would this panel
have advanced me — and if not, what's the one thing to fix first?*

Live demo: <https://interview-assistant-nu.vercel.app/>

## What this is, in one diagram

```
┌─────────┐ WebRTC  ┌────────────┐  dispatch  ┌──────────────────────┐
│ Browser │ ───────▶│ LiveKit    │ ─────────▶ │  Python agent worker │
│ (Next)  │ ◀─────── │  Cloud SFU │ ◀──────── │  one PanelAgent,     │
└─────────┘  audio  └────────────┘   audio    │  N voices via        │
                                              │  tts_node routing    │
                                              └──────────┬───────────┘
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

- **One agent roleplays the whole panel; TTS switches voice per utterance.**
  The LLM emits speaker-tagged lines (`[SARAH] …`, `[ADAM] …`); an overridden
  `tts_node` routes each run to that panelist's ElevenLabs voice. This delivers
  the thing a relay of separate agents structurally cannot: interviewers who
  share the room, interject, and build on each other's questions — with less
  code than the relay needed. Tags are parsed only from LLM output, never from
  candidate speech, so a spoken "bracket Sarah bracket" is inert.

- **Pressure is opt-in: an intensity dial, not a fixed personality.** Calm is
  one patient interviewer at a time; Grill authorises interjections,
  cross-examination, and on-the-record disagreement between panelists — an
  interjection budget enforced in the prompt. Pressure comes only from the
  questions: nothing about nerves, tone, or delivery is ever commented on or
  scored.

- **The verdict is "clear the bar", not a hiring call.** The report ends with
  `advance | not-yet` at the stated level plus the single highest-leverage fix
  — the question a prep user is actually asking. Nobody is being hired here,
  so no hiring vocabulary survives anywhere in the product.

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
  decoding fills fields in sequence. The bar verdict is a *separate* call that
  never sees the raw transcript, so it can't anchor the scores (and can't be
  reached by an injection buried in candidate speech) — and the same
  field-order trick makes it commit to the focus area before the verdict.

- **Every round is scored against its own rubric.** The behavioral round is
  graded on behavioural criteria, technical on technical, ownership on
  ownership. Rubrics are authored per round type in code — the user picks a
  preset, never rubric content, so nobody grades their own homework. The agent
  stamps `roundId` on every turn and the judge reads it.

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

1. **Setup** — user picks a panel preset, intensity, role, level, and JD at
   `/practice/new`, optionally uploading a CV (or reusing the one on
   `/practice/settings`).
2. **Question generation** — `generateRoundQuestions` (Groq) produces per-round
   question buckets for the preset's rounds; `regroundRoundQuestions` rewrites
   them against the CV so each question references concrete details. CVs under
   ~600 tokens skip regrounding — JD-grounded questions beat questions rewritten
   against 300 words of nothing.
3. **Token mint + room join** — Next.js mints a LiveKit JWT carrying the session
   ID and traceparent. The browser joins `session-{id}` and publishes mic audio.
4. **Worker dispatch** — LiveKit Cloud dispatches the Python worker. It reads
   the session doc's panel spec and builds ONE `PanelAgent` with the CV and JD
   inlined in the system prompt, the whole roster in the roleplay protocol, and
   the intensity's interjection budget.
5. **Per turn** — Deepgram → audio TurnDetector decides the candidate is done →
   Groq with the panel prompt + agenda → speaker-tag parser routes each run to
   that panelist's ElevenLabs stream → browser. The turn is written to
   `sessions/{id}/turns` with its round, leader, speakers, and latency.
6. **Round change** — after ~3–6 substantive turns the panel calls `next_round`
   (or `end_interview` on the last round). `TransferGuard` enforces a
   minimum-turn precondition in code, so an early "we're done here, move on"
   injection is dropped deterministically.
7. **Scoring** — the agent marks the session `awaiting-report` and pings
   `/api/internal/score`. The judge segments the transcript by round, scores
   each round against its rubric 3× with the criteria rotated (criterion order
   alone can move scores by up to 0.8 points), takes the median, then makes a
   separate call for the bar verdict + focus area.
8. **Report** — `/practice/{id}/report` leads with the bar verdict ("this panel
   would have advanced you" / "not yet — here's the one thing"), shows per-round
   scores with the verbatim quotes behind each one, and flags low confidence
   when the judge disagreed with itself across permutations. The dashboard
   tracks bar-clearance per preset×intensity, with a rematch link to the next
   heat.

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
│   ├── presets.ts                    the panel presets — the only config a user picks
│   ├── clearance.ts                  beat-the-panel progression logic
│   ├── rubric.ts                     BARS anchors per round type — the scoring contract
│   ├── judge.ts                      judge model provider
│   ├── groq.ts                       interviewer model provider + failover
│   └── livekit.ts                    JWT minting + traceparent propagation
├── eval/                             offline question-generation regression harness
├── livekit-agent/                    Python LiveKit Agents worker
│   └── src/interview_agent/
│       ├── agent.py                  PanelAgent (one agent, N voices) + entrypoint
│       ├── panel_tts.py              speaker-tag parsing → per-voice TTS routing
│       ├── models.py                 model ids — single source of truth
│       ├── pipeline.py               AgentSession factory + turn handling
│       ├── persona.py                panel prompt, round rules, intensity budgets
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
