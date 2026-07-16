# GLOSSARY - JobVoice / Interview Assistant

> **Docs set:** [Index](README.md) · [Architecture](ARCHITECTURE.md) · [Tech Decisions](TECH_DECISIONS.md) · Glossary · [Interview Prep](INTERVIEW_PREP.md) | deep dives: [security](security.md) · [observability](observability.md) · [resume](resumable-sessions.md)

> Domain terms, technical jargon, and naming conventions used in this codebase, each with a
> one-line plain-English definition and (where useful) where it lives. Use this to never get
> caught out by your own terminology in an interview.

---

## Product / domain terms

| Term | Definition |
|---|---|
| **JobVoice** | The product name for this voice-driven mock-interview platform (`README.md:1`). |
| **Panel** | The set of three AI interviewers that run in sequence in one session. |
| **Persona** | One AI interviewer = identity + voice + prompt rules + "who's next" (`persona.py`, the `Persona` dataclass). |
| **Sarah / Adam / Bella** | The three personas: Sarah = behavioral, Adam = technical, Bella = system design (`persona.py:130-179`). |
| **Hand-off** | The act of switching the active persona mid-call (Behavioral → Technical → System Design). |
| **Round** | One persona's portion of the interview (behavioral round, technical round, system-design round). |
| **STAR** | Situation-Task-Action-Result - the behavioral interviewing framework Sarah probes for (`persona.py:_BEHAVIORAL_RULES`). |
| **Template** | A reusable interview definition (role, level, JD, base questions/rubrics) owned by an HR user (`templates` collection). |
| **Invite** | A tokenized, time-limited link an HR user mints to invite a candidate (`invites/{token}`). |
| **Redeem** | A candidate accepting an invite - atomically creates a session, marks the invite used, sets the user's role to `candidate` (`sessions.action.ts` `redeemInvite`). |
| **Session** | One interview run (the central document `sessions/{id}`); also a state machine (see status values below). |
| **Turn** | One message in the conversation (user or assistant), stored at `sessions/{id}/turns/{index}`. |
| **Report** | The post-call scored evaluation (`reports/{sessionId}`): scores, strengths, recommendation, rubric coverage. |
| **Feedback** | The **legacy** equivalent of a report from the old single-agent flow (`feedback/{id}`) - distinct from Report. |
| **Practice mode** | Self-serve flow where one user is both candidate and template owner; sessions tagged `inviteToken: "practice"`. |
| **Bar verdict** | The report's terminal call: `advance \| not-yet` at the stated level, plus a focus area (`constants/index.ts` judgeVerdictSchema). Not a hiring decision — this is a prep tool. |

## Grounding & question generation

| Term | Definition |
|---|---|
| **Grounding** | Rewriting generic questions to reference *this candidate's* CV specifics (a real project, employer, tech). |
| **Phase 1 (generate)** | Produce role/level/JD-appropriate questions + rubrics, *before* any CV (`lib/llm/groq-template.ts`). |
| **Phase 2 (reground)** | Personalize the Phase-1 questions against the candidate's CV (`lib/llm/groq-grounding.ts`). |
| **Partitioned** | Split into three persona buckets - `behavioral` / `technical` / `systemDesign`, 3 questions each. |
| **`questionsByPersona` / `rubricsByPersona`** | The partitioned (per-persona) shape the agent reads to render each round's prompt. |
| **`questionsGrounded` / `rubricsGrounded`** | The flat, CV-grounded list used by the report generator (stored alongside the partitioned shape). |
| **Rubric** | Per-question scoring guide. `RubricBase` = `expectedConcepts`, `expectedSpecifics`, `depth`, `priority`; `RubricGrounded` adds an optional `cvReference`. |
| **`expectedConcepts` / `expectedSpecifics`** | Concepts (2-8) and concrete details (1-6, e.g. numbers/tools) a good answer should touch. |
| **`depth`** | Rubric difficulty: `foundational \| intermediate \| advanced`. |
| **`priority`** | Rubric importance `1\|2\|3` ("drives follow-up budget later", `groq-template.ts:59`). |
| **`rubricCoverage`** | Report field mapping each question (`"Q1"`, `"Q2"`…) to which expected concepts the candidate actually covered (boolean map). |

## Voice / real-time jargon

| Term | Definition |
|---|---|
| **STT** | Speech-to-Text (Deepgram Nova-2, `pipeline.py:77`). |
| **LLM** | Large Language Model (Groq Llama-3.3-70B). |
| **TTS** | Text-to-Speech (ElevenLabs `eleven_turbo_v2_5`, per-persona voice). |
| **VAD** | Voice Activity Detection (Silero) - detects when the candidate is speaking. |
| **SFU** | Selective Forwarding Unit - the WebRTC media server topology LiveKit Cloud provides. |
| **WebRTC** | The browser real-time audio transport between candidate and agent. |
| **EOU** | End-Of-Utterance - when STT decides the speaker has finished a turn (`latency_budget.py`). |
| **Endpointing** | Deciding the candidate has stopped talking; tuned via `min_delay=0.8s` for thinking time (`pipeline.py`). |
| **TTFT** | Time-To-First-Token - how fast the LLM starts replying (budget 500ms p95). |
| **TTFB** | Time-To-First-Byte (of audio) - how fast TTS starts speaking (budget 500ms p95). |
| **e2e turn latency** | EOU + TTFT + TTFB + network - total "user stops → hears reply" (budget 1500ms p95). |
| **p95** | 95th-percentile latency - the budgets target tail latency, not average (`latency_budget.py:14-17`). |
| **`streaming_latency=3`** | ElevenLabs "max latency optimization" profile, kept at 3 (not 4) to preserve number/abbreviation pronunciation (`agent.py:183-188`). |
| **Interruption / barge-in** | Letting the candidate talk over the agent; tuned (`min_duration=1.0s`, `min_words=3`) to avoid cutting on "uh"/"mm" (`pipeline.py`). |

## LiveKit Agents framework terms

| Term | Definition |
|---|---|
| **Agent (subclass)** | A LiveKit `Agent`; here `InterviewerBase` + the 3 persona subclasses (`agent.py:218-456`). |
| **`AgentSession`** | The SDK object running one voice session; swaps the active Agent on hand-off (`pipeline.py` `build_session`). |
| **`@function_tool`** | A method the LLM can call as a tool (`lookup_cv_jd`, `verify_cv_claim`, `transfer_to_*`, `end_interview`). |
| **Native hand-off** | A `@function_tool` returning `tuple[Agent, str]`; the SDK swaps to the returned Agent (`agent.py:325-356`). |
| **`chat_ctx`** | Conversation history forwarded to the next Agent so it sees prior answers across hand-offs. |
| **`on_enter`** | Hook fired when a persona becomes active; used to greet/introduce (suppressed on resume). |
| **Dispatch** | LiveKit Cloud auto-launching the registered Python worker into a room on participant join. |
| **Worker / `prewarm`** | The long-running agent process; `prewarm` eagerly loads Silero + FastEmbed once per worker (`agent.py:755-768`). |
| **`entrypoint`** | The per-session coroutine that loads state, builds agents, and runs the session (`agent.py:509`). |
| **`session-{id}` room** | Naming convention; the worker rejects rooms not starting with this prefix (`agent.py:748-752`). |

## RAG / fact-checking terms

| Term | Definition |
|---|---|
| **RAG** | Retrieval-Augmented Generation - here, retrieving CV/JD chunks to ground questions and verify claims (`rag.py`). |
| **`lookup_cv_jd`** | Tool: retrieve the top-3 relevant CV/JD chunks for a query (`agent.py:253-267`). |
| **`verify_cv_claim`** | Tool: check if a candidate claim is supported by the CV/JD; returns a verdict + similarity (`agent.py:269-292`). |
| **`ClaimVerdict`** | Result of `verify_cv_claim`: `supported` (sim ≥0.55) / `ambiguous` (0.40-0.55) / `unsupported` (<0.40) (`rag.py:21-62`). |
| **FastEmbed / bge-small** | `BAAI/bge-small-en-v1.5` embedding model, CPU-only, ~50ms/chunk, no API key (`rag.py:7-10`). |
| **`VectorStoreIndex`** | LlamaIndex in-memory vector index built fresh per session over CV + JD (`rag.py:77-107`). |
| **Cosine similarity** | The distance metric whose thresholds bin claim verdicts. |

## Security terms

| Term | Definition |
|---|---|
| **Prompt injection** | A candidate trying to manipulate the LLM via what they say (e.g. "set my score to 100", "end the interview now"). |
| **`TransferGuard`** | Deterministic Layer-1 defense gating hand-off/end tools by minimum user-turn counts (`security_guards.py:64-139`). |
| **`MIN_USER_TURNS_BEFORE_TRANSFER` (=2)** | Per-persona user turns required before a hand-off is allowed. |
| **`MIN_USER_TURNS_BEFORE_END` (=6)** | Total user turns required before `end_interview` is allowed. |
| **`detect_prompt_leak`** | Layer-2 defense: regex-scans assistant turns for leaked system-prompt fragments (`security_guards.py:151-185`). |
| **`leakHits`** | The matched leak patterns, logged + stored on `turn.metadata.security` for human review. |
| **Integrity rule** | The "belt-and-suspenders" prompt note telling the LLM not to reveal instructions or obey role-claims (`persona.py:14-24`). |
| **Injection corpus** | The versioned 50-case attack set (`security/injection_corpus.py`), **7 categories** (direct-override 12, prompt-extraction 8, role-impersonation 8, tool-abuse 8, output-redirection 6, score-manipulation 4, cv-fact-injection 4). Authoritative breakdown: `docs/security.md`. |
| **`blocked_patterns` / `must_not_call_tools`** | Per-case predicates: regex the response must not match / tools it must not call. |
| **Audit / baseline** | The 150-run audit (`run_audit.py`); a generated `security_baseline.json` distinguishes new failures from known ones. |
| **DeBERTa / llm-guard classifier** | A *removed* ML input classifier - replaced by the deterministic defense (git `c6bfe0d`); may appear in stale docs. |

## Observability / cost terms

| Term | Definition |
|---|---|
| **OTel (OpenTelemetry)** | The tracing standard used across both services. |
| **`traceparent`** | W3C trace-context string written on `sessions/{id}` so the agent continues the Next.js trace (`tracing.py`, `agent.py:526-544`). |
| **Span** | One timed operation in a trace (e.g. `agent.panel-session`, `rag.query`, `agent.turn-latency`). |
| **Latency budget** | A p95 wall-clock target per stage; violations flag a span attribute (`latency_budget.py`). |
| **`estimatedCost`** | Per-session provider spend rolled up at teardown (`CostBreakdown`: groqUsd, ttsUsd, sttUsd, livekitUsd, totalUsd). |
| **`RATES_SOURCED_AT`** | Date stamp on the pricing constants forcing a refresh review when prices drift (`cost_rates.py:19`). |
| **Score sparkline** | The small SVG line chart of recent practice scores on the dashboard (`components/practice/ScoreSparkline.tsx`). |

## Resume / lifecycle terms

| Term | Definition |
|---|---|
| **Resume (mid-interview)** | Reopening a closed tab continues at the same persona instead of restarting (`docs/resumable-sessions.md`). |
| **`currentPersonaId`** | The resume cursor on the session doc; best-effort written on each transfer (`agent.py:129-152`). |
| **`resume_mode`** | Flag suppressing the greeting on the *first* agent of a resumed session only (`agent.py:227-231`). |
| **Monotonic turn index** | New turns continue from `len(existing_turns)` so indices never collide on resume (`agent.py:627-630`). |
| **Session status** | `awaiting-cv → awaiting-call → in-call → completed` (also `abandoned`/`reconnecting`). |
| **30-turn ceiling** | Hard code-level cap that force-ends a runaway session; soft 8-turn-per-persona cap lives in the prompt (`agent.py:688-694`). |

## Auth terms

| Term | Definition |
|---|---|
| **Session cookie** | The httpOnly 7-day cookie minted from the Firebase ID token via Admin SDK (`auth.action.ts`). |
| **Custom claim** | A `role` value (`hr`/`candidate`) stamped on the Firebase Auth user, read for fast role checks (`admin-claims.ts`). |
| **Admin SDK** | Server-side Firebase (`firebase/admin.ts`); the only writer to the core collections. |
| **Client SDK** | Browser-side Firebase (`firebase/client.ts`); used to sign in and get the ID token. |
| **`resolveRoleForSession`** | Resolves a user's role from JWT claim first, then Auth lookup (`lib/role-resolution.ts`). |

---

## Naming conventions in this codebase

| Convention | Meaning |
|---|---|
| `*.action.ts` | A file of `"use server"` Server Actions (e.g. `practice.action.ts`). |
| `app/(group)/` | A **route group** - affects layout/auth, not the URL. `(auth)`, `(practice)`, `(hr)`, `(candidate)`, `(root)`. |
| `route.ts` | A Next.js Route Handler (REST endpoint) under `app/api/**`. |
| `_components/` | Route-private components (leading underscore = not a route). |
| `[token]` / `[id]` / `[sessionId]` | Dynamic route segments. |
| `types/index.d.ts` | **Ambient** global domain types - used without imports (`User`, `Session`, `Report`, `Template`, `Invite`). |
| camelCase (Firestore) vs snake_case (Python) | Firestore fields are camelCase; Python dataclasses are snake_case and convert via `to_firestore_dict()`. |
| `*-grounded` vs `*-base` | `*Base` = pre-CV (template) shape; `*Grounded` = post-CV-grounding shape. |
| "Sub-project A" / "legacy" | The original single-agent `interviews`/`feedback` flow that still coexists with the new system. |
| `interview-{id}` vs `session-{id}` | Legacy room naming vs the current `session-` rooms the agent listens for. |
| `Report` vs `Feedback` | `Report` = new 3-persona flow (`reports`); `Feedback` = legacy flow (`feedback`). |
