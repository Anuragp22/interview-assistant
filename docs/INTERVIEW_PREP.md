# INTERVIEW PREP - JobVoice / Interview Assistant

> **Docs set:** [Index](README.md) · [Architecture](ARCHITECTURE.md) · [Tech Decisions](TECH_DECISIONS.md) · [Glossary](GLOSSARY.md) · Interview Prep | deep dives: [security](security.md) · [observability](observability.md) · [resume](resumable-sessions.md)

> Your study doc for talking about this project in job interviews. Everything here is
> anchored to real code (paths relative to the project root). Where a rationale isn't written
> in the code, it's tagged **[ASSUMED]** - be honest about that distinction; interviewers
> respect "I inferred this" far more than a confident guess.

---

## 1. Pitch

### 30-second pitch
> "JobVoice is a real-time, voice-driven mock-interview platform. A candidate joins a WebRTC
> call and is interviewed by a **three-persona AI panel** - a behavioral, a technical, and a
> system-design interviewer, each with its own voice - that hand off to each other mid-call.
> The questions are generated and then re-grounded against the candidate's actual CV, and
> during the call the AI **fact-checks claims against the CV** in real time. It's built as two
> services: a Next.js app and a Python LiveKit voice agent, coordinated through Firestore,
> with prompt-injection defenses in code, end-to-end tracing, and per-session cost tracking."

### 2-minute pitch
> "The product is a mock interviewer. Three flows feed it: an HR user builds a reusable
> template and invites candidates by link; a candidate redeems the invite, uploads a CV, and
> takes the interview; or any user self-practices. All three converge on the same voice
> experience.
>
> Architecturally it's **two cooperating services around Firestore**. The Next.js 15 app
> handles auth, UI, and all the LLM work that isn't live conversation - it generates the
> question bank in two phases (generic-for-the-role, then re-grounded against the specific
> CV), mints a LiveKit access token, and after the call reads the transcript and generates a
> scored report. The actual conversation runs in a separate **Python LiveKit Agents worker**:
> Deepgram for speech-to-text, Groq's Llama-3.3-70B for the LLM (chosen for its fast
> time-to-first-token, which is the main lever on conversational latency), and ElevenLabs for
> per-persona voices. The two services never call each other directly - they communicate only
> through a Firestore session document and a shared LiveKit room.
>
> The interesting engineering is in four places. **Multi-agent orchestration:** three LLM
> personas with native hand-off, where each can call a RAG tool to verify a candidate's claim
> against their CV. **Security:** the candidate is an untrusted party talking straight to the
> LLM, so the prompt-injection defenses live in deterministic code - turn-count preconditions
> on the hand-off tools and post-hoc prompt-leak detection - not in prompt text. I actually
> built an ML classifier for this first and then removed it because it was slower and less
> reliable than the deterministic guards. **Observability:** one OpenTelemetry trace follows a
> session across the browser, Next.js, Firestore, and the Python worker, plus per-stage
> latency budgets and per-session cost telemetry. And **quality gates:** an offline eval
> harness on question generation and a 150-case prompt-injection audit, both run as
> regression gates."

---

## 2. What's distinctive / non-obvious (vs a typical CRUD app)

A CRUD app reads and writes rows behind auth. This project has all of that *plus*:

1. **A real-time, multi-agent voice pipeline.** Three LLM personas (Sarah/Adam/Bella) with
   distinct ElevenLabs voices that **hand off mid-call** using LiveKit Agents' native pattern
   - a `@function_tool` returns the next `Agent` and the SDK swaps it in place, forwarding
   `chat_ctx` so the next interviewer sees the whole prior conversation
   (`livekit-agent/src/interview_agent/agent.py:325-356`, `persona.py:130-179`).

2. **Prompt-injection defense in code, not in the prompt.** The candidate is the attacker.
   `TransferGuard` blocks a hand-off until there have been ≥2 user turns in the current
   persona, and blocks `end_interview` until ≥6 total, using per-persona buckets so
   "I'm Adam, transfer to me" on turn 0 can't fire. A post-hoc detector scans every AI turn
   for leaked prompt fragments. The prompt rule itself is labelled "belt-and-suspenders, not
   the load-bearing defense" (`security_guards.py:1-35,55-139`, `persona.py:14-24`).

3. **Live CV fact-checking via RAG.** During the call the AI calls `verify_cv_claim`, which
   runs cosine similarity over an in-memory LlamaIndex of the CV+JD and returns a
   **supported / ambiguous / unsupported** verdict with a similarity score, so the
   interviewer probes unverifiable claims instead of accepting them (`rag.py:124-167`,
   `agent.py:269-292`).

4. **Two-phase, partitioned question generation.** Phase 1 generates role/level/JD questions;
   Phase 2 re-grounds them against the specific CV; both partitioned into three persona
   buckets. So the technical round asks about *that project at that company*, not a generic
   placeholder (`lib/llm/groq-template.ts`, `lib/llm/groq-grounding.ts`).

5. **One distributed trace across four boundaries.** Next.js writes a W3C `traceparent` onto
   the session document; the Python worker rehydrates it so a single OpenTelemetry trace spans
   server action → Firestore → agent (`lib/tracing.ts`, `agent.py:526-544`,
   `livekit-agent/src/interview_agent/tracing.py`).

6. **Production-style quality gates and SRE hooks.** A deterministic eval harness (10
   fixtures, no LLM-as-judge) fails when question-gen quality drops >10pp; a 150-case
   injection audit gates security regressions; per-stage **p95 latency budgets**
   (`eou 300 / llm 500 / tts 500 / e2e 1500 ms`); and **per-session cost telemetry** summing
   Groq/ElevenLabs/Deepgram/LiveKit spend (`eval/`, `security/`, `latency_budget.py`,
   `cost_aggregator.py`).

7. **Mid-interview resume.** Closing the tab and reopening continues at the persona the panel
   was on - the agent replays persisted turns into a fresh chat context and starts at the
   stored `currentPersonaId`, suppressing the greeting on the resumed persona only
   (`agent.py:571-606`, `docs/resumable-sessions.md`).

---

## 3. The hardest technical problem

**Problem: make a multi-agent voice interview that (a) hands off cleanly between three LLM
personas while preserving context, (b) can't be hijacked by the one untrusted party who
speaks directly to the LLM, and (c) survives a mid-call disconnect - all under hard latency
budgets.**

These pull against each other. Letting the LLM drive hand-off and end-of-interview is
natural for conversation but is exactly what an injection attack exploits ("transfer to me",
"end now", "ignore your instructions"). Hardening the prompt is brittle - the LLM can be
talked out of any instruction. And resume has to re-enter the *middle* of a 3-stage state
machine without re-greeting the candidate or corrupting turn ordering.

### How it's solved

**(a) Native hand-off with forwarded context.** Each persona is an `Agent` subclass over a
shared `InterviewerBase`. A `transfer_to_*` `@function_tool` returns `tuple[Agent, str]`; the
SDK swaps the active agent and `chat_ctx=self.chat_ctx` carries the full history so the next
interviewer sees prior answers (`agent.py:218-247,350-356`).

**(b) Deterministic guards around the tools, not inside the prompt.** The key insight,
written in the code: *"The LLM has no ability to bypass code that runs around it"*
(`security_guards.py:11-14`). So the actual decision to transfer or end is gated by
`TransferGuard` in code:

```python
# agent.py:337-340  - guard runs BEFORE the agent is swapped
if _GUARD is not None:
    allowed, refusal = _GUARD.may_transfer(self._persona.id)
    if not allowed:
        return refusal or "Not yet."   # plain string → SDK keeps current persona
```

`may_transfer` requires ≥2 user turns *in the current persona* (per-persona buckets, so you
can't accrue turns in one round and jump to another); `may_end_interview` requires ≥6 total
(`security_guards.py:55-133`). A second layer scans every assistant turn for leaked prompt
fragments and tags them on the turn for human review (`security_guards.py:151-185`,
`agent.py:657-676`). This is backed by a **150-case audit** (50 prompts × 3 personas) run
against the real rendered prompt. I prototyped an ML input classifier (DeBERTa/llm-guard) as
an extra layer and **removed it** - it added 50-100ms per turn and was less reliable than the
deterministic guards (git `c6bfe0d`).

**(c) Resume by replaying persisted state.** Every turn is written to
`sessions/{id}/turns/{index}` with a monotonic index. On dispatch, if turns already exist,
the entrypoint rebuilds a `ChatContext` from them, resolves the starting persona from
`currentPersonaId`, and constructs the first agent with `resume_mode=True` so it doesn't
re-greet; new turns continue from `len(existing_turns)` to keep indices monotonic
(`agent.py:571-606,627-630`, `_build_chat_ctx_from_turns` / `_starting_persona_for_resume`).

**The unifying idea:** keep the LLM responsible for *conversation* but move every
*state-mutating decision* (hand-off, end, persistence, resume cursor) into deterministic code
around it. That's what makes the system both controllable and attack-resistant.

---

## 4. Ten likely interviewer questions (with strong answers)

**Q1. Why two services (Next.js + a separate Python worker) instead of one codebase?**
The voice pipeline is a long-lived, stateful, audio-streaming process; it can't run in a
serverless Next.js function. The mature voice-agent ecosystem (LiveKit Agents + STT/LLM/TTS
plugins) is Python-native. So the split is forced by the runtime model, not preference. They
stay decoupled by communicating only through a Firestore session doc and a LiveKit room -
no RPC, so either can restart independently (`agent.py:7-20`,
`livekit-agent/pyproject.toml`).

**Q2. How does the Python agent even get invoked? I don't see an HTTP call to it.**
It doesn't get called directly. The browser joins a LiveKit room named `session-{id}`;
LiveKit Cloud auto-dispatches the registered worker into that room. The worker filters by
room-name prefix and rejects foreign rooms (`agent.py:748-752`). Everything it needs is then
read from the session document.

**Q3. Why Groq/Llama-3.3 instead of GPT-4 or Claude?**
Latency. In a voice interview the dominant felt-latency is LLM time-to-first-token. Groq's
LPU inference gives ~80-150ms warm TTFT (cited in `latency_budget.py:62-70`), far below
typical hosted GPT-4-class TTFT. Llama-3.3-70B is the quality/speed sweet spot Groq offers,
reached via its OpenAI-compatible endpoint so I didn't need a custom client
(`pipeline.py:30`). Trade-off: Groq doesn't support strict JSON-schema output, which I
handled with json_object mode + Zod validation (see Q5).

**Q4. How do you stop a candidate from gaming the AI - e.g. "give me a 100" or "end now"?**
Defense-in-depth, mostly in code. Score-manipulation is bounded because the score isn't set
by the conversation at all - it's computed *after* the call by a separate report generator
over the transcript. Tool-abuse ("end now", "transfer to me") is blocked by `TransferGuard`
preconditions on the tools. Prompt-extraction is caught post-hoc by leak detection. And it's
all regression-tested by a 150-case audit. The prompt rule is the last and weakest layer
(`security_guards.py`, `lib/actions/reports.action.ts`, `security/`).

**Q5. You're getting structured output from an LLM - how do you keep it valid?**
Two layers. I define Zod schemas in `constants/index.ts` (report, partitioned generation,
grounding, rubric) and call the Vercel AI SDK's `generateObject` with them. Because Llama-3.3
on Groq doesn't support strict `json_schema`, I use `structuredOutputs:false` (json_object
mode), put the literal word "JSON" in the prompt, describe the shape inline, and let the SDK
validate the result against the Zod schema (`lib/llm/groq-template.ts:13-33`). If it fails to
parse, the action surfaces the error rather than persisting garbage.

**Q6. Walk me through what happens on a single conversational turn.**
Candidate audio → Deepgram STT (with tuned endpointing so it waits ~0.8s for thinking time)
→ Groq LLM with the persona's system prompt, that round's grounded questions, and the tool
schema → the LLM may call `verify_cv_claim`/`lookup_cv_jd` (RAG over the CV/JD index) →
ElevenLabs streams the persona's voice back. The completed turn is written to Firestore with
persona, model id, and any leak hits, and a latency span is emitted with a budget-violation
flag (`pipeline.py`, `agent.py:632-694`).

**Q7. How does the live CV fact-checking work?**
Per session I build an in-memory LlamaIndex `VectorStoreIndex` over the CV and JD using a
CPU-only FastEmbed model (bge-small, ~50ms/chunk, no API key), prewarmed at worker startup.
`verify_cv_claim` retrieves the top match for a claim and bins the cosine similarity:
≥0.55 supported, 0.40-0.55 ambiguous, <0.40 unsupported, returning a natural-language verdict
so it streams cleanly as a tool result. The thresholds were calibrated against the test
fixtures (`rag.py:21-62,124-167`).

**Q8. How does resume after a tab close work without re-greeting or breaking ordering?**
Turns are persisted with a monotonic index and the active persona is written to
`currentPersonaId` on each transfer. On reconnect the agent sees existing turns, replays them
into a fresh `ChatContext`, starts at the stored persona with `resume_mode=True` (which
suppresses the greeting on that one agent), and continues the turn index from
`len(existing_turns)`. If `currentPersonaId` is missing it degrades to starting at Behavioral
rather than crashing (`agent.py:571-606`, `_starting_persona_for_resume`).

**Q9. How do you know the AI's question quality didn't regress when you change a prompt?**
An offline eval harness (`eval/run.ts`) runs question generation over 10 hand-curated
(CV, JD) fixtures and scores the output with **deterministic scorers** - no LLM-as-judge, so
it's reproducible and free. It compares against `baselines.json` and fails if any per-fixture
metric drops more than 10 percentage points. Same idea for security via the injection audit.

**Q10. How do you track cost and latency in production?**
One OpenTelemetry trace spans all processes via a W3C `traceparent` on the session doc. Each
turn emits an `agent.turn-latency` span checked against p95 budgets (eou 300 / llm 500 /
tts 500 / e2e 1500 ms). At session teardown a cost aggregator sums Groq tokens, ElevenLabs
characters, Deepgram audio-seconds, and LiveKit participant-minutes into `estimatedCost` on
the session, surfaced on the practice dashboard. Pricing constants carry a `RATES_SOURCED_AT`
date so stale rates are visible (`tracing.py`, `latency_budget.py`, `cost_aggregator.py`,
`cost_rates.py`).

> **Bonus prep - also rehearse:** "How would you scale to 1,000 concurrent interviews?"
> (LiveKit worker autoscaling, Firestore write hot-spotting on the turns subcollection,
> Groq rate limits + the retry the audit already does, embedding-model memory per worker.)

---

## 5. Honest weaknesses & trade-offs (and how I'd improve them)

Interviewers love this section. Each item is real and verifiable.

1. **Doc/code drift on the STT model.** The pipeline runs `deepgram.STT(model="nova-2")`
   (`pipeline.py:77`), but the cost calculator and latency-budget comment say **nova-3**
   (`cost_rates.py:10,28`, `latency_budget.py:24`). So the cost estimate is priced for a
   model I'm not running. *Fix:* single source of truth for the model name + a test asserting
   the pipeline model matches the rates file.

2. **Two parallel systems still ship ("Sub-project A").** The original single-agent flow
   coexists with the new 3-persona one: `app/(root)/interview/[id]/`,
   `lib/actions/general.action.ts` (`createFeedback`), `lib/actions/interview.action.ts`,
   `app/api/interviews/generate`, the `interviews`/`feedback` Firestore collections, and
   `feedbackSchema`. Those legacy collections also have **looser security rules**
   (`allow read, write: if request.auth != null`, `firestore.rules:58-66`). *Fix:* finish the
   migration (`scripts/migrate-v0.1.ts`), delete the legacy surface, tighten the rules.

3. **Stale documentation.** `ONBOARDING.md` describes a single-persona "Sarah only" agent and
   claims "no tests / no scripts"; the previous interview-prep doc showed a "DeBERTa input
   classifier" that's been removed. *Fix:* these new `docs/` files; add a doc-lint or a
   "docs updated in same PR" checklist (the README's own note suggests this).

4. **Module-level mutable globals in the agent.** Hand-off state lives in module globals
   (`_GUARD`, `_ACTIVE_PERSONA_ID`, `_PANEL_CONTEXT`, …) and is only safe because LiveKit
   forks one subprocess per job (`agent.py:91-127`). It works, but it's a latent foot-gun if
   the worker ever runs multiple sessions in-process. *Fix:* encapsulate session state in an
   object passed through `RunContext` / agent instances.

5. **The cross-process protocol is hand-mirrored.** `types/livekit.d.ts` mirrors the Python
   message envelope and `lib/cost-rates.ts` mirrors `cost_rates.py`, kept in sync by comments
   only - drift is silent until runtime. *Fix:* generate one from the other, or share a JSON
   schema; at minimum a CI check that the rate constants match (a cost-rates test already
   asserts the math, not cross-language equality).

6. **The security baseline isn't committed.** `security_baseline.json` is generated locally
   via `--baseline` and isn't in the repo, so the audit's regression gate has nothing to
   compare against in a fresh checkout/CI. *Fix:* commit a baseline and run the audit in CI.

7. **Prompt-leak detection is post-hoc, not preventive.** By design it logs/tags rather than
   blocking (to avoid streaming-token interception latency, `security_guards.py:25-34`), so a
   leak is still spoken once before anyone notices. *Acceptable* given the latency trade-off,
   but worth saying out loud; a streaming guard or output filter is the next step if the
   threat model tightens.

8. **No CI config in the repo / limited automated enforcement.** The gates (eval, audit,
   pytest, vitest) exist but aren't wired to a committed CI workflow. *Fix:* add GitHub
   Actions running all four on PRs.

9. **Single-language, English-only, single-region assumptions.** STT is `language="en-US"`
   and latency budgets assume a reasonable network. *Fix:* parameterize language; measure
   p95 from real regions before promising the budgets globally.

---

## 6. One-line "résumé bullet" translations

If a bullet on your CV maps to this project, here's the defensible version:

- *"Built a real-time multi-agent voice interviewer"* → 3 LiveKit `Agent` personas with
  native hand-off + forwarded chat context (`agent.py`, `persona.py`).
- *"Hardened an LLM product against prompt injection"* → deterministic tool-precondition
  guards + post-hoc leak detection + a 150-case regression audit; removed an ML classifier
  that underperformed (`security_guards.py`, `security/`, git `c6bfe0d`).
- *"Implemented end-to-end distributed tracing"* → one OTel trace across browser → Next.js →
  Firestore → Python via a W3C traceparent on the session doc (`tracing.py`, `agent.py`).
- *"Added eval-driven quality gates for LLM output"* → deterministic 10-fixture
  question-gen harness failing on >10pp regressions (`eval/`).
- *"Production-grade cost & latency observability"* → per-stage p95 budgets + per-session
  multi-provider cost roll-up (`latency_budget.py`, `cost_aggregator.py`).

> Verify any claim before you say it - open the cited file. The fastest way to lose
> credibility is to describe a feature the interviewer then can't find in the repo.

---

## 7. War stories ("tell me about a hard bug / challenge")

These are anchored in real commits and code comments. The debugging narrative is marked
**[ASSUMED]** where it's a plausible reconstruction, not stated in the repo.

1. **The three hand-off bugs** (commit `e988935 "align panel hand-off with livekit-agents
   docs (3 real bugs)"`). The first multi-agent build (a) returned just an `Agent` from
   `transfer_to_*` instead of `tuple[Agent, str]`, (b) had no `on_enter` greeting per
   persona, and (c) did not forward `chat_ctx`. Symptom **[ASSUMED]:** the next interviewer
   started cold and re-asked things the candidate had already answered, because it inherited
   an empty history. Fix: return `(next_agent, message)`, add `on_enter` on each subclass,
   thread `chat_ctx=self.chat_ctx` (`agent.py:218-247,350-356`). Lesson: read the framework's
   hand-off contract, don't assume it.

2. **The invented voice ID** (commit `7ea170f "replace invented Bella voice_id with real
   ElevenLabs ID"`). Bella's `voice_id` was guessed/hallucinated. Symptom **[ASSUMED]:**
   ElevenLabs rejected it or silently fell back, so Bella didn't sound distinct from the other
   personas. Fix: verify against `GET /v1/voices` and pin a real premade ID; the code now
   carries "Verified via GET /v1/voices against the account's catalog" (`persona.py:168-170`).
   Lesson: never trust a model-suggested external identifier.

3. **The audit flaked under rate limits** (commit `be48184 "retry Groq rate limits in the
   prompt-injection audit runner"`). The full audit fires 150 Groq calls fast and hit 429s,
   so a clean codebase failed CI at random. Fix: `OpenAI(..., max_retries=10)`
   (`security/runner.py:157`), and `run_audit.py` marks a thrown call as a failure-in-report
   but **not** a regression, so a network blip can't poison the baseline. Lesson: separate
   "the model regressed" from "the network flaked."

4. **The phantom dependency** (`pyproject.toml:20-24`). `llama-index-embeddings-fastembed`
   0.6.0 dropped `fastembed` from its declared deps, so `uv sync` installed the wrapper but
   not the ONNX backend it imports at runtime. Symptom **[ASSUMED]:** RAG worked locally
   (cached) then crashed on a fresh environment at the first embed call. Fix: pin
   `fastembed>=0.4,<1` directly, with a comment explaining why. Lesson: a transitive dep you
   actually import must be a direct dep.

5. **Interview pacing felt wrong** (commit `d3525d4 "tune interrupt + endpointing thresholds
   for interview pacing"`). LiveKit defaults (`interruption.min_duration 0.5s`, `min_words 0`,
   `endpointing.min_delay 0.5s`) made the agent cut candidates off on filler sounds ("uh",
   "mm") and jump in during thinking pauses. Fix: `min_duration 1.0s` AND `min_words 3`, and
   `endpointing 0.8s`, with `resume_false_interruption=True` so a wrong interrupt-call resumes
   cleanly (`pipeline.py:88-106`). Lesson: voice UX is tuned by listening, not by defaults.

Bonus stories: **the ML classifier you built then deleted** (`dba1c6e` add llm-guard/DeBERTa
input classifier → `c6bfe0d` remove it): ~35% recall, +50-100ms/turn, plus a torch CVE, so
the deterministic guards won outright. And **the llama-index CVE pin** (GHSA-cr7q-2w66-hjcm,
`pyproject.toml:14-18`): bumped to 0.13 for a temp-file fix, with a compatibility note that
`rag.py` only uses `Document`/`VectorStoreIndex`/`Settings`/`embed_model`, all unchanged.

---

## 8. Deep-cut facts the overview skips (study before a senior round)

The architecture doc tells the story; these are the implementation details a senior follow-up
will probe.

**Voice turn-taking** (`pipeline.py:88-106`): the session uses a custom `turn_handling` dict,
not defaults. `interruption.min_duration=1.0`, `min_words=3` (AND-ed), `endpointing.min_delay=0.8`,
`false_interruption_timeout=2.0`. TTS is **not** on the session; each `Agent` owns its own
ElevenLabs voice so the swap changes the voice. `GROQ_API_KEY` is read at session construction
and raises there, so a misconfigured worker **fails fast on dispatch, not mid-call**
(`pipeline.py:42-47`).

**The audit as a system** (`security/runner.py`, `run_audit.py`): runs at `temperature=0` and
`max_tokens=512` for reproducibility; uses a fixed candidate fixture ("Anurag Patel", Senior
Backend Engineer); `TOOLS_SCHEMA` is **hand-mirrored** to the real `@function_tool`
declarations (drift risk if you add a tool and forget); tool-abuse is checked by set
intersection on `response.tool_calls` (the hardest signal, a real call not just text); the
corpus runs `_validate()` at import to reject duplicate case IDs; baseline regression =
`baseline_passing & failing_now` (only previously-passing cases can regress); exit codes
0=safe / 1=regression / 2=setup.

**Cost telemetry internals** (`cost_aggregator.py`): `session_usage_updated` fires monotonic
cumulative snapshots, so the aggregator **overwrites, not accumulates**; `finalize()` is
idempotent and caches its result because `session_duration` is sampled from
`time.monotonic()` and would otherwise drift between the multiple `finally`-path calls; the
rollup runs even on error paths so a crashed session still records a partial bill. On the TS
side, an unknown model string returns **$0 silently** (`cost-rates.ts`), and the TS/Python
rate files are synced by hand (bump `RATES_SOURCED_AT` in both).

**Latency math** (`metrics_bridge.py`): EOU isn't measured directly; it's derived residually
as `max(0, e2e - llm_ttft - tts_ttfb)`. The first assistant turn (the `on_enter` greeting)
has no preceding user turn, so its metrics are **skipped**, not logged as a violation.

**Eval scorers** (`eval/scorers.ts`): four deterministic, weighted scorers - cvGrounding
**0.35**, partitionCorrectness **0.30**, hallucinationGuard **0.20**, schemaPass **0.15**.
Partitioning is judged by keyword marker dictionaries per persona; hallucination is a
**hard zero** if any placeholder (`[X]`, `{x}`, `TBD`, `TODO`) leaks; cv-grounding accepts a
fuzzy match (normalized substring, else ≥60% significant-token overlap).

**Persistence + load guards** (`persistence/firestore.py`, `session_data.py`): two credential
paths (`FIREBASE_SERVICE_ACCOUNT_JSON` base64 OR the 3-var split); init swallows `ValueError`
to be idempotent for tests; constructor enforces "exactly one of interview_id/session_id" via
`(a is None) == (b is None)`; `list_turns()` defends with `if d is None: continue` against
docs deleted mid-read. The session load allows `awaiting-call` / `in-call` / `reconnecting`
(`in-call` is the **resume** case), and a session created before the panel rollout raises a
backward-compat error telling the user to start a new practice.

**Known failure modes to own** (don't let these ambush you):
- `setUserRole` runs **outside** the `redeemInvite` transaction; if it throws after commit,
  the invite is redeemed but the role isn't stamped, so the role-gated layout locks the
  candidate out (`sessions.action.ts`). It's idempotent on retry, but there's no auto-retry.
- The report write is **two non-atomic writes** (report doc, then session status); the second
  can fail, leaving a report with a non-`completed` session (`reports.action.ts`).
- `signIn` doesn't return `{success:true}` on the happy path - callers infer success from the
  absence of failure (`auth.action.ts`).
- LiveKit token TTL is hardcoded `30m` (`lib/livekit.ts`); a 30-minute-plus session loses its
  token mid-call.
- Pasted CV has a 50-char minimum but **no maximum** before it's sent to Groq
  (`sessions.action.ts`).

> **Still must do hands-on (docs can't substitute):** run `npm run eval` and read its output;
> run the security audit `--smoke`; and at least once, set the turn-handling values back to the
> LiveKit defaults and feel the agent cut you off. You want to have *heard* the thing you
> describe in story #5.
