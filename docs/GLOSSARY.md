# GLOSSARY - JobVoice / Interview Assistant

> **Docs set:** [Index](README.md) · [Architecture](ARCHITECTURE.md) · [Tech Decisions](TECH_DECISIONS.md) · Glossary | deep dives: [security](security.md) · [observability](observability.md) · [resume](resumable-sessions.md)

> Domain terms, technical jargon, and naming conventions used in this codebase, each with a
> one-line plain-English definition and (where useful) where it lives. Use this to never get
> caught out by your own terminology in an interview.
>
> **Rule:** entries name a **symbol in a file**, not a line number. Line numbers drift; the
> symbol is what you actually grep for. Terms that no longer exist are not deleted — they're
> in [Superseded terms](#superseded-terms) at the bottom, same convention as
> [`TECH_DECISIONS.md` §10](TECH_DECISIONS.md#10-superseded-decisions).

---

## Product / domain terms

| Term | Definition |
|---|---|
| **JobVoice** | The product name for this voice-driven panel-interview simulator (`README.md`). |
| **Panel** | The 2-3 AI interviewers that run one session — all roleplayed by **one** agent, each in their own voice. |
| **Panelist / Persona** | One interviewer = id + name + expertise area + voice id + `VoiceSettings`. **Data, not code:** written onto the session doc from `lib/presets.ts`; Python parses it as `PanelPersonaSpec` (`session_data.py`). |
| **Sarah / Adam / Bella** | The `big-tech-swe` roster: behavioral / technical / system-design (`lib/presets.ts`). `startup-generalist` runs **Maya** (founder) + **Dev** (senior eng); `new-grad-swe` runs Sarah + Adam. |
| **Preset** | The panel definition a user picks: roster + rounds + default intensity. Three exist — `big-tech-swe`, `startup-generalist`, `new-grad-swe` (`lib/presets.ts` `PRESETS`). The user picks **context, never rubric content** — you cannot grade your own homework. |
| **Round** | One leg of the interview, led by one panelist. Round ids: `behavioral \| technical \| systemDesign \| ownership \| fundamentals` (`lib/rubric.ts` `RoundId`). Rounds are **prompt structure, not agents**. |
| **Intensity dial** | How hard the panel pushes: `calm \| standard \| grill` (`lib/presets.ts` `Intensity`). The one lever on pressure; the user picks it per session. |
| **Interjection** | A **non-lead** panelist speaking inside an assistant turn — i.e. cutting in. Counted post-hoc by comparing each turn's `speakers` against the round leader's tag (`agent.py` `_on_item`). |
| **Interjection budget** | How many interjections per round an intensity allows: calm **0**, standard **≤1**, grill **≤3** (`persona.py` `INTENSITY_RULES`). Prompt-enforced — an overrun is a quality bug, never a runtime block. |
| **Session** | One interview run (the central document `sessions/{id}`); also a state machine (see status values below). |
| **Turn** | One message in the conversation (user or assistant), stored at `sessions/{id}/turns/{index}`. |
| **Template** | The role/level/JD + Phase-1 questions doc (`templates/{id}`). In practice mode the practising user owns it — `hrUid` now just means "who owns this template". |
| **Report** | The post-call scored evaluation (`reports/{sessionId}`): per-round criteria scores, bar verdict, focus area, judge provenance. |
| **Practice mode** | The **only** flow: one signed-in user is both candidate and template owner. Sessions are tagged `inviteToken: "practice"` — a sentinel the dashboard filters on (`practice.action.ts`). |
| **Bar verdict** | The report's terminal call: `advance \| not-yet` at the stated level (`constants/index.ts` `judgeVerdictSchema`). `advance` requires overall ≥ 3.5 **and** no round below 2.5. Not a hiring decision — this is a prep tool. |
| **Focus area** | The single highest-leverage thing to fix before the next session: `{ title, why, firstStep }`. Decoded **before** `barVerdict` so the model commits to the fix before the verdict (`constants/index.ts`). |
| **Clearance** | "Highest intensity survived" per preset — a completed session whose panel said `advance` (`lib/clearance.ts` `computeClearance`). Deliberately **not** a score average: the judge is noisy by up to 2 points on identical transcripts, so a yes/no ladder is the honest progression metric. |
| **Beat the panel** | The product loop the clearance ladder drives: clear a preset at calm → the next challenge is standard → then grill (`components/practice/ClearanceCard.tsx`). |

## The panel (one agent, N voices)

| Term | Definition |
|---|---|
| **`PanelAgent`** | The one LiveKit `Agent` subclass that roleplays **every** interviewer (`agent.py`). Replaced a relay of three per-persona Agents — see [Superseded terms](#superseded-terms). |
| **Roleplay panel** | The pattern: one prompt casts the LLM as the whole panel, and a TTS router gives each panelist a voice. Delivers interjections and cross-talk — which a relay structurally cannot — with *less* code. |
| **Speaker tag** | `[SARAH]` — the uppercase-name markup every LLM utterance must begin with (`persona.py` `_PANEL_TEMPLATE`, "SPEAKER PROTOCOL"). It is **routing markup**: the candidate hears voices and never sees brackets. |
| **Tag protocol is output-only** | Tags are parsed **only** from LLM output (`panel_tts.py`). Candidate speech arrives via STT as plain text and is never tag-parsed — a spoken "bracket Sarah bracket" cannot forge a speaker. |
| **`tts_node`** | The overridden Agent node that owns synthesis: it routes each contiguous speaker run to that panelist's own ElevenLabs stream (`agent.py` `PanelAgent.tts_node`). |
| **Speaker run / segment** | One contiguous stretch of text by one speaker. Buffered whole before synthesis, so a failed segment can be **replayed** from the start rather than resumed mid-sentence (`agent.py` `_synthesize_segment`). |
| **`split_speaker_segments`** | The streaming tag parser: yields `(persona_id, text_piece)` pairs, holding back only a suffix that could still become a tag (`panel_tts.py`). |
| **`naturalize_tags`** | Rewrites `[ADAM] Why?` → `Adam: Why?` before a turn is persisted, and returns the speaker list. The judge reads names; the LLM's chat context keeps the raw tags (`panel_tts.py`). |
| **`next_round`** | The tool that advances the panel: increments `_ACTIVE_ROUND`, persists `currentRound`, and calls `update_instructions` — it **never swaps the Agent** (`agent.py`). |
| **`end_interview`** | The tool that ends the panel: sets a module-level `asyncio.Event` the entrypoint watches in parallel with the session task (`agent.py`). |
| **`render_panel_prompt`** | Renders the one prompt: roster + speaker protocol + CV/JD inlined + rounds + agenda + intensity rules + round rules (`persona.py`). |
| **`ROUND_RULES`** | Conduct rules per **round type** — the fixed vocabulary presets draw from (`persona.py`). |
| **`_DOC_CHAR_BUDGET` (=16,000)** | Per-document character cap on the CV/JD inlined into the prompt. Truncation is **marked** in the text — a silent cut would make the interviewer confidently believe a candidate's last job doesn't exist (`persona.py` `_clip`). |
| **Module-level state** | `_PANEL_CONTEXT`, `_PANEL`, `_ACTIVE_ROUND`, `_GUARD`, `_END_INTERVIEW_FLAG`, `_DB` bridge the entrypoint and the tools. Safe **only because** LiveKit forks a subprocess per job (`agent.py`). |

## Grounding & question generation

| Term | Definition |
|---|---|
| **Grounding** | Rewriting generic questions to reference *this candidate's* CV specifics (a real project, employer, tech). |
| **Phase 1 (generate)** | Produce per-round questions + base rubrics from role/level/JD in one Groq call, *before* any CV (`lib/llm/groq-template.ts` `generateRoundQuestions`). |
| **Phase 2 (reground)** | Rewrite the Phase-1 questions against the candidate's CV (`lib/llm/groq-grounding.ts` `regroundRoundQuestions`). |
| **Thin CV / `CV_TOKEN_FLOOR_CHARS` (=2,400)** | Below ~600 tokens the CV is too thin to reground against — rewriting against 300 words fabricates specificity the interview then confidently probes. Phase 2 is **skipped**; the session records `grounding: "jd-only" \| "cv"` (`practice.action.ts`). |
| **Round-keyed schema** | The generation schemas are **built per call** from the preset's round ids (`constants/index.ts` `roundsTemplateSchema` / `roundsGroundingSchema`), so strict decoding enforces exactly this panel's shape. `z.record` would not work — Groq's strict mode doesn't accept it. |
| **`questionsByRound` / `rubricsByRound`** | The per-round buckets on the session doc; the agent renders each round's agenda from `questionsByRound` (`types/index.d.ts`, `session_data.py`). |
| **Rubric** | Per-question scoring guide from generation. `RubricBase` = `expectedConcepts`, `expectedSpecifics`, `depth`, `priority`; `RubricGrounded` adds a **nullable** `cvReference` (`constants/index.ts`, `types/index.d.ts`). Distinct from the BARS anchors the judge actually scores against. |
| **`expectedConcepts` / `expectedSpecifics`** | Concepts (2-8) and concrete details (1-6, e.g. numbers/tools) a good answer should touch. |
| **`depth`** | Rubric difficulty: `foundational \| intermediate \| advanced`. |
| **`priority`** | Rubric importance `1\|2\|3`. |
| **`.nullable()`, not `.optional()`** | Groq strict `json_schema` requires every property in `required`, so "no CV reference" is an explicit `null`. `.optional()` made Phase-2 grounding 400 deterministically (`constants/index.ts`; `tests/groq-schema-strict.test.ts` makes the class unrepresentable). |
| **`withSchemaRetry`** | Retries **only** the generation-validation failure class (`json_validate_failed`, `NoObjectGeneratedError`) — never a 401 or a deterministic schema rejection (`lib/llm/schema-retry.ts`). |

## Scoring / the judge

| Term | Definition |
|---|---|
| **Judge** | The scorer: Gemini Flash-Lite, a **different model family** from the interviewer, so the interviewer's blind spots aren't also the grader's (`lib/judge.ts`, `lib/llm/judge-report.ts`). |
| **BARS** | Behaviourally Anchored Rating Scales — the 0-5 scoring contract (`lib/rubric.ts`). Anchored scales reach r≈.56 validity vs r≈.35 unanchored. |
| **Anchor** | The text describing what the **transcript contains** at one score level. Never a trait of the person: "gave a concrete example with a measurable outcome" is scoreable, "seemed confident" is not (`lib/rubric.ts` `Criterion.anchors`). |
| **Criterion** | One scored dimension: `id`, `label`, `definition`, six anchors (0-5). Three per round, registered in `ROUND_CRITERIA` (`lib/rubric.ts`). |
| **`structureAndClarity`** | The cross-cutting **communication** criterion, scored once across the whole interview — how the ANSWER was organised, judged from content alone (`lib/rubric.ts` `COMMUNICATION_CRITERION`). |
| **Rotation median** | Score the transcript `PERMUTATIONS = 3` times with the criteria **rotated**, take the per-criterion median (`lib/llm/judge-report.ts`). Criterion order alone shifts judge scores by up to 0.8 points and flips the top candidate in 16-39% of cases. Rotation (not shuffle) keeps it deterministic; median (not mean) survives one outlier run. |
| **`maxDisagreement`** | The largest spread between permutation runs on any single criterion. Surfaced on the report as **provenance** — high spread is displayed as low confidence, not hidden (`judge-report.ts`, `types/index.d.ts` `Report.judge`). |
| **Evidence before score** | The schema orders `evidence` → `rationale` → `score`, because structured decoding fills fields in order. Empty evidence ⇒ score **must** be 0 (`constants/index.ts` `criterionScoreSchema`). |
| **Two-pass judging** | Pass 1 scores against the anchors; pass 2 writes the verdict from the **finished scores only** — it never sees the raw transcript, so an injection in candidate speech cannot reach it (`judge-report.ts`). |
| **`segmentByRound`** | Splits the flat turn list into rounds: explicit `roundId` → the legacy `personaId`→round map → the round currently in progress (`judge-report.ts`). |
| **`ROUND_WEIGHTS` / `COMMUNICATION_WEIGHT`** | Weight of each round + communication in the overall. All **1** — equal weighting is the honest default: we have not measured that one round predicts better than another (`lib/rubric.ts`). |
| **Delimit → neutralise → schema** | The judge's three defense layers: candidate text lives in a `<candidate_transcript>` block; literal delimiters in candidate text are stripped; the **schema** is the real defense (`judge-report.ts`). |

## Voice / real-time jargon

| Term | Definition |
|---|---|
| **STT** | Speech-to-Text — Deepgram `nova-3` (`models.py` `STT_MODEL`, wired in `pipeline.py`). |
| **LLM** | Large Language Model — Groq `openai/gpt-oss-120b` (`models.py` `DEFAULT_LLM_MODEL`, `GROQ_MODEL` overrides). |
| **TTS** | Text-to-Speech — ElevenLabs `eleven_flash_v2_5` (`models.py` `TTS_MODEL`), one prewarmed instance per panelist voice. |
| **VAD** | Voice Activity Detection (Silero) — knows "is there sound", which is *not* the question "are they finished". |
| **Turn detector** | The **audio** end-of-turn model that decides the candidate is done: `TurnDetector(unlikely_threshold=0.45)` (`pipeline.py`). Runs on audio, so it costs no STT round trip and sees prosody. 9.9% false-cutoff vs ~27.7% VAD-only at a 300ms budget. |
| **SFU** | Selective Forwarding Unit - the WebRTC media server topology LiveKit Cloud provides. |
| **WebRTC** | The browser real-time audio transport between candidate and agent. |
| **EOU** | End-Of-Utterance. **Derived, not measured**: `max(0, e2e − llm_ttft − tts_ttfb)` — the assistant `MetricsReport` carries no EOU field (`latency_budget.py`, `metrics_bridge.py`). |
| **Endpointing** | The floor beneath the turn detector: `min_delay=0.4s`, `max_delay=3.0s` (`pipeline.py` `_INTERVIEW_TURN_HANDLING`). |
| **TTFT** | Time-To-First-Token - how fast the LLM starts replying (budget 500ms p95). |
| **TTFB** | Time-To-First-Byte (of audio) - how fast TTS starts speaking (budget 500ms p95). |
| **e2e turn latency** | EOU + TTFT + TTFB + network - total "user stops → hears reply" (budget 1500ms p95). |
| **p95** | 95th-percentile latency — the budgets target tail latency, not average (`latency_budget.py`). |
| **`streaming_latency=3`** | ElevenLabs "max latency optimization" profile, kept at 3 (not 4) to preserve number/abbreviation pronunciation (`agent.py` `_build_tts_for_spec`). |
| **Interruption / barge-in** | Letting the candidate talk over the agent; tuned (`min_duration=1.0s`, `min_words=3`, AND-ed) to avoid cutting on "uh"/"mm" (`pipeline.py`). |
| **The governing trade-off** | Cutting a candidate off mid-thought is a worse failure than being half a second slow — worse as a product *and* as a fairness matter. Every turn-handling value buys patience with latency, deliberately (`pipeline.py`). |

## LiveKit Agents framework terms

| Term | Definition |
|---|---|
| **Agent (subclass)** | A LiveKit `Agent`; here exactly **one** — `PanelAgent` (`agent.py`). |
| **`AgentSession`** | The SDK object running one voice session. Owns STT + LLM + VAD + turn detection and **no TTS** — `tts_node` owns synthesis (`pipeline.py` `build_session`). |
| **`@function_tool`** | A method the LLM can call as a tool. There are exactly two: `next_round` and `end_interview` (`agent.py`). |
| **`update_instructions`** | How a round change lands: the prompt is re-rendered on the same Agent, rather than a new Agent being constructed (`agent.py` `next_round`). |
| **`chat_ctx`** | Conversation history. On resume, persisted turns are replayed into a fresh `ChatContext` so the panel sees prior answers (`agent.py` `_build_chat_ctx_from_turns`). |
| **`on_enter`** | Hook fired when the agent becomes active; the round leader greets, introduces the panel, and asks the first agenda question (suppressed on resume). |
| **Dispatch** | LiveKit Cloud auto-launching the registered Python worker into a room on participant join. |
| **Worker / `prewarm`** | The long-running agent process; `prewarm` loads Silero VAD once per worker and installs the OTel `TracerProvider` (`agent.py`). |
| **`entrypoint`** | The per-session coroutine that loads state, builds the PanelAgent, and runs the session (`agent.py`). |
| **`session-{id}` room** | Naming convention; the worker rejects rooms not starting with this prefix (`agent.py` `_request_fnc`, `SESSION_ROOM_PREFIX`). |
| **`FallbackAdapter`** | Wraps one `openai.LLM` per Groq account so a 429 or timeout on the active key doesn't take the turn down mid-answer. Skipped when only one key is configured (`pipeline.py` `_build_groq_llm`). |

## Security terms

| Term | Definition |
|---|---|
| **Prompt injection** | A candidate trying to manipulate the LLM via what they say (e.g. "set my score to 100", "end the interview now"). The candidate is the one untrusted party who talks to the LLM — and their CV is inlined into the system prompt. |
| **Security-in-code, not in-prompt** | The design principle: the LLM can be talked out of any instruction, so the load-bearing defenses run **around** it — preconditions before a tool mutates state, detection after text is produced (`security_guards.py`). |
| **`TransferGuard`** | Deterministic Layer-1 defense gating `next_round` / `end_interview` by minimum user-turn counts (`security_guards.py`). |
| **`MIN_USER_TURNS_BEFORE_TRANSFER` (=2)** | User turns required **in the current round** before `next_round` may fire. |
| **`MIN_USER_TURNS_BEFORE_END` (=6)** | Total user turns across the session required before `end_interview` may fire. |
| **`detect_prompt_leak`** | Layer-2 defense: regex-scans assistant turns for leaked system-prompt fragments (`security_guards.py`). Detection, not prevention — it does not block. |
| **`leakHits`** | The matched leak patterns, logged at WARNING + stored on `turn.metadata.security` for human review. |
| **Integrity rule** | The "belt-and-suspenders" prompt note telling the LLM not to reveal instructions, not to obey role-claims, and never to emit scores (`persona.py` `_INTEGRITY_RULE`). Explicitly **not** load-bearing. |
| **Injection corpus** | The versioned **54**-case attack set (`security/injection_corpus.py`), **10 categories** (direct-override 12, prompt-extraction 8, role-impersonation 8, tool-abuse 8, output-redirection 6, score-manipulation 4, cv-fact-injection 4, speaker-tag-spoofing 2, round-control 1, interjection-budget 1). Authoritative breakdown: `docs/security.md`. |
| **`blocked_patterns` / `must_not_call_tools`** | Per-case declarative predicates: regex the response must not match / tools it must not call (`injection_corpus.py`). |
| **Audit / baseline** | The audit run at **grill** intensity against the real rendered prompt (`security/run_audit.py`); the committed `security_baseline.json` (52 passing) distinguishes new failures from known ones. |

## Observability / cost terms

| Term | Definition |
|---|---|
| **OTel (OpenTelemetry)** | The tracing standard used across both services. |
| **`traceparent`** | W3C trace-context string written on `sessions/{id}` so the agent continues the Next.js trace — **not** in the LiveKit JWT, not in room metadata (`lib/tracing.ts` `currentTraceparent()`, `tracing.py` `context_from_traceparent`). |
| **Span** | One timed operation in a trace: `practice.create-session`, `agent.panel-session`, `agent.on-enter`, `agent.turn-latency`, `agent.next-round`, `agent.end-interview`, `session.cost`. |
| **`trace.propagated`** | The attribute on `agent.panel-session` recording whether the trace actually crossed the process boundary — so unlinked sessions are one filter away (`agent.py`). |
| **Latency budget** | A p95 wall-clock target per stage; violations flag a span attribute (`latency_budget.py`). |
| **`latency.partial`** | The tag on a turn missing a leg. Partial turns are emitted, not dropped: they're disproportionately the slow ones, so dropping them computed p95 over a sample that excluded exactly the turns most likely to breach (`metrics_bridge.py`). |
| **`estimatedCost`** | Per-session provider spend rolled up at teardown (`CostBreakdown`: groqUsd, ttsUsd, sttUsd, livekitUsd, totalUsd). Written in a `finally`, so a crashed session still records its partial bill. |
| **`RATES_SOURCED_AT`** | Date stamp on the pricing constants forcing a refresh review when prices drift; must be bumped in **both** `cost_rates.py` and `lib/cost-rates.ts` (`cost_rates.py`). |
| **`qualityTelemetry`** | What the panel actually did: `interjections` + per-round `{turns, interjections, durationSeconds}`. The only thing that **measures** the promise the intensity dial makes (`agent.py`, `types/index.d.ts`). |
| **`gen_ai.*`** | OTel GenAI semantic-convention aliases on the cost/latency spans, so an LLM-aware backend groups them without config. Deliberately **not** aliased: `gen_ai.prompt` / `gen_ai.completion` — no span in this repo carries candidate content (`docs/observability.md`). |

## Resume / lifecycle terms

| Term | Definition |
|---|---|
| **Resume (mid-interview)** | Reopening a closed tab continues at the same round instead of restarting (`docs/resumable-sessions.md`). |
| **`currentRound`** | The resume cursor on the session doc: the round **index** the panel is on. Best-effort written on each `next_round` — a Firestore blip during a round change can't poison the panel; worst case the next resume restarts at round 0 (`agent.py` `_persist_current_round`). |
| **`resume_mode`** | Flag suppressing the greeting on a resumed session (`agent.py` `PanelAgent.on_enter`). |
| **Monotonic turn index** | New turns continue from `len(existing_turns)` so indices never collide on resume (`agent.py` `entrypoint`). |
| **Session status** | `awaiting-cv → awaiting-call → in-call → awaiting-report → completed`, plus `abandoned` (`types/index.d.ts`). The agent loads a session only in `awaiting-call` or `in-call` (`session_data.py`). Not to be confused with the browser's `reconnecting` LiveKit *connection* state (`SessionRoomClient.tsx`), which is local React state, not a session status. |
| **`awaiting-report`** | The **durable hand-off marker**, written by the agent before the best-effort score ping — the agent is the only party that actually knows the interview ended (`reporting.py` `mark_awaiting_report`). |
| **Reconciler** | The daily Vercel cron sweeping what the ping missed: `awaiting-report` older than 2 min, `in-call` older than 30 min. Capped at `MAX_PER_RUN = 2` per sweep (`app/api/internal/reconcile`, `lib/reconcile-staleness.ts`). |
| **30-turn ceiling** | Hard code-level cap that force-ends a runaway session; the soft 8-turn-per-round cap lives in the prompt (`agent.py` `_on_item`). |
| **`agentStartError`** | Breadcrumb written when the agent's startup crashes, so a session stranded at `awaiting-call` says *why* (`agent.py` `_record_startup_failure`). |
| **Daily quota** | Per-user cap on practice-session creation (default 5/UTC day). Cost telemetry *measures* spend; this is the only thing that **bounds** it (`lib/quota.ts`). |

## Auth terms

| Term | Definition |
|---|---|
| **Session cookie** | The httpOnly 7-day cookie minted from the Firebase ID token via Admin SDK (`auth.action.ts`). |
| **Admin SDK** | Server-side Firebase (`firebase/admin.ts`); the only writer to the core collections — `firestore.rules` makes every core-collection write server-only (`allow write: if false`), so a candidate can never write their own score. |
| **Client SDK** | Browser-side Firebase (`firebase/client.ts`); used to sign in and get the ID token. |
| **`FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n")`** | The escaped-newline normalisation in `firebase/admin.ts` — the single most common setup failure. |

---

## Naming conventions in this codebase

| Convention | Meaning |
|---|---|
| `*.action.ts` | A file of `"use server"` Server Actions (`auth` · `practice` · `reports`). |
| `app/(group)/` | A **route group** - affects layout/auth, not the URL. `(auth)`, `(root)`, `(practice)`. |
| `route.ts` | A Next.js Route Handler (REST endpoint) under `app/api/**`. |
| `app/api/internal/` | Machine-to-machine endpoints (`score`, `reconcile`) authed by a constant-time-compared `INTERNAL_API_SECRET` bearer, not a session cookie — the caller is a worker process, not a user. |
| `[token]` / `[id]` / `[sessionId]` | Dynamic route segments. |
| `types/index.d.ts` | **Ambient** global domain types - used without imports (`User`, `Session`, `Report`, `Template`). |
| camelCase (Firestore) vs snake_case (Python) | Firestore fields are camelCase; Python dataclasses are snake_case and convert via `to_firestore_dict()`. |
| `*Base` vs `*Grounded` | `*Base` = pre-CV (template) shape; `*Grounded` = post-CV-grounding shape. |
| `roundId` vs `personaId` | `roundId` = which round a turn belongs to (current). `personaId` = which panelist leads it. Both are stamped on every turn; the judge prefers `roundId` and falls back to `personaId` for relay-era turns. |
| `*Spec` (Python) | A frozen dataclass parsed **from the session doc**, never from `lib/presets.ts` — TypeScript stays the single source of truth (`session_data.py` `PanelSpec`, `PanelPersonaSpec`). |
| `*View` (Python) | A narrow, prompt-facing projection of a spec (`persona.py` `PanelPersonaView`, `PanelRoundView`). |
| `_legacy_*` / `LEGACY_*` | Compatibility paths for documents written before a rework — e.g. `_legacy_panel_spec()` synthesizes the big-tech panel for pre-preset session docs (`session_data.py`, `lib/rubric.ts` `LEGACY_ROUND_IDS`). |

---

## Superseded terms

Kept, not deleted — these appear in git history, in `docs/superpowers/` plans, and in
interview questions about how the system evolved. **None of them exist in the shipping code.**
Same convention as [`TECH_DECISIONS.md` §10](TECH_DECISIONS.md#10-superseded-decisions), which
carries the full reasoning for each reversal.

### ~~RAG / fact-checking terms~~
**Superseded: 2026-07 (panel rework). Replaced by: inlining the CV + JD in the prompt.**

| Dead term | What it was |
|---|---|
| ~~**RAG**~~ | Retrieval-Augmented Generation — retrieving CV/JD chunks to ground questions and verify claims, in a `rag.py` that no longer exists. |
| ~~**`lookup_cv_jd`**~~ | Tool: retrieve the top-k relevant CV/JD chunks for a query. |
| ~~**`verify_cv_claim`**~~ | Tool: check whether a candidate claim was supported by the CV/JD; returned a verdict + similarity. |
| ~~**`ClaimVerdict`**~~ | Its result: `supported` (cosine ≥0.55) / `ambiguous` (0.40-0.55) / `unsupported` (<0.40). |
| ~~**FastEmbed / bge-small**~~ | `BAAI/bge-small-en-v1.5` embeddings, CPU-only, no API key, prewarmed per worker to avoid a ~3s first-session load. |
| ~~**`VectorStoreIndex`**~~ | The LlamaIndex in-memory index built fresh per session over CV + JD. |

**Why it went:** it solved a context-window problem that does not exist here — a CV and a JD
together are a few thousand tokens and simply **fit**. It cost a synchronous index build
blocking the event loop before the first greeting, a model download to prewarm, three
dependencies, and an extra LLM round trip per tool-using turn — to look up a document we
could just include (`persona.py` `render_system_prompt` docstring).

**What replaced the claim-checking:** not a similarity threshold, but a prompt rule —
the CV is in front of the panel, so read it directly, and **do not accuse**: people work on
things they never wrote down. Ask them to walk through it and judge whether they talk about
it like someone who was actually there (`persona.py` `COMMON_RULES`). Kinder *and* better
signal than a cosine bin.

**Live residue:** some audit-corpus predicates still name the deleted tools — a known gap,
documented in `docs/security.md`.

### ~~Relay / hand-off terms~~
**Superseded: 2026-07 (panel rework). Replaced by: one `PanelAgent` + `tts_node` voice routing.**

| Dead term | What it was |
|---|---|
| ~~**Hand-off**~~ | Switching the *active persona* mid-call (Behavioral → Technical → System Design). |
| ~~**`transfer_to_*`**~~ | The hand-off tools — `transfer_to_technical`, `transfer_to_system_design`. |
| ~~**Native hand-off**~~ | A `@function_tool` returning `tuple[Agent, str]`; the SDK swapped to the returned Agent. |
| ~~**`InterviewerBase` + 3 subclasses**~~ | `BehavioralInterviewer` / `TechnicalInterviewer` / `SystemDesignInterviewer`, each owning its own TTS. |
| ~~**`currentPersonaId`**~~ | The old resume cursor (`"behavioral" \| "technical" \| "system-design"`), written on every transfer. |

**Why it went:** a relay is a sequence of monologues. Only one agent is active at a time, so
interviewers structurally **cannot** interject, cross-examine, or disagree — which is the
entire product.

**Live residue, worth knowing:**
- `TransferGuard` and `may_transfer()` **survived under their relay-era names**, still gating
  the round-advance tool — the tool is now `next_round`, but the turn-count precondition is
  unchanged (`security_guards.py`; naming note in `docs/security.md`).
- `persona.py` still carries `GENERAL_TEMPLATE`, `HANDOFF_RULE`, `render_system_prompt`, and
  the three `Persona` constants. The **constants are live** — `_legacy_panel_spec()` reads
  their voice ids for pre-preset session docs. The template and `render_system_prompt` are
  exercised only by tests.
- `questionsByPersona` / `rubricsByPersona` and `currentPersonaId` still parse off legacy
  session docs (`session_data.py` `_parse_panel`, `types/index.d.ts`).

### ~~Model ids that are no longer running~~
**Superseded: see `TECH_DECISIONS.md` §10 for each.**

| Dead term | Replaced by | Why |
|---|---|---|
| ~~**Groq Llama-3.3-70B**~~ (`llama-3.3-70b-versatile`) | `openai/gpt-oss-120b` | Groq decommissions it 2026-08-16; gpt-oss is faster (~500 vs ~280 tok/s), cheaper, and supports strict `json_schema`. |
| ~~**ElevenLabs `eleven_turbo_v2_5`**~~ | `eleven_flash_v2_5` | ElevenLabs deprecated the Turbo line; guidance is Flash in all cases — same voices, same price, lower first-byte latency. |
| ~~**Deepgram `nova-2`**~~ | `nova-3` | Streaming WER 8.4% → 6.84% at latency parity. The pipeline once ran nova-2 while the cost table billed nova-3 — that bug is why `models.py` exists. |

### ~~Removed product surfaces~~
**Superseded. Removed entirely — the product is a practice tool.**

| Dead term | What it was |
|---|---|
| ~~**Invite**~~ | A tokenized, time-limited link an HR user minted to invite a candidate (`invites/{token}`). |
| ~~**Redeem**~~ | A candidate accepting an invite — created a session and set their role to `candidate`. |
| ~~**Feedback**~~ | The legacy single-agent flow's equivalent of a report (`feedback/{id}`). |
| ~~**Sub-project A / legacy flow**~~ | The original single-agent `interviews`/`feedback` flow. |
| ~~**`interview-{id}` rooms**~~ | Legacy room naming; the worker now only accepts `session-` rooms. |
| ~~**`(hr)` / `(candidate)` route groups**~~ | The HR template/invite surfaces and the candidate review surface. |
| ~~**Custom claim / `UserRole`**~~ | A `role` value (`hr`/`candidate`) stamped on the Firebase Auth user for fast role checks. Practice mode is role-less. |
| ~~**`resolveRoleForSession`**~~ | Resolved a user's role from JWT claim first, then Auth lookup. |
| ~~**`rubricCoverage`**~~ | Report field mapping each question (`"Q1"`, `"Q2"`…) to which expected concepts were covered. The report now carries per-criterion `evidence` quotes instead. |
| ~~**`recommendation`**~~ | The hiring-style enum (`strong-hire` … `no-hire`) on the report. Nobody is being hired here. |
| ~~**Score sparkline**~~ | The SVG line chart of recent scores on the dashboard. Removed with the clearance ladder: a noisy judge makes a score trend-line theatre, and "watch your number go up" was the wrong loop. |

**Live residue:** `Invite`, `Feedback`, `Interview`, `UserRole`, and `Recommendation` are still
**declared** in `types/index.d.ts`; `lib/role-resolution.ts` and `lib/admin-claims.ts` still
exist but are **not called from app code**. `templates.hrUid`, the `inviteToken: "practice"`
sentinel, and `Report.recommendation` (marked `LEGACY`, so old reports still render) are the
deliberate survivors.

### ~~DeBERTa / llm-guard classifier~~
**Superseded: git `c6bfe0d`. Replaced by: the deterministic `TransferGuard` preconditions.**

An ML prompt-injection classifier screening candidate input before it reached the LLM. It was
a probabilistic gate in a hot path where a deterministic one is available — and it guarded the
wrong thing: it screened *input*, while the outcome we care about is whether a **tool fires**.
The hot path carries no classifier. May still appear in `ONBOARDING.md`, which is stale.
</content>
