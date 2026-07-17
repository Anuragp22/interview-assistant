# Production-Credibility Hardening — Design

**Date:** 2026-07-17
**Status:** Approved (four phases, each an independently shippable PR)
**Goal:** Close the gap between "the engineering is real" and "a senior reviewer or a live user would trust it." Audience is both: engineers reading the repo AND real users on the deployed product.

## Context

A full-codebase audit (judged by code behavior, not comments) crossed against 2026
voice-agent production literature (Coval, Hamming, Cekura, F22 Labs, 12-factor agents,
LiveKit deployment docs) found:

**Already genuinely strong** — cross-process W3C trace propagation (web → Firestore doc →
agent session span), live per-session cost accounting wired to the dashboard, per-turn
latency spans (LLM TTFT / TTS TTFB / e2e), fail-closed auth on every route, permutation-
debiased judge, durable report reconciler.

**Credibility killers found:**

1. `docs/observability.md` documents a deleted architecture (RAG index, `verify_cv_claim`,
   `lookup_cv_jd`, `agent.transfer` spans, old models/prices).
2. `eval/run.ts` `checkBaselineModel` is a `return true` stub and `eval/baselines.json`
   was recorded on `llama-3.3-70b-versatile` while production runs `openai/gpt-oss-120b`
   — the drift gate silently makes an invalid cross-model comparison.
3. Zero live-path resilience: single Groq key on the live LLM (`pipeline.py`), no
   try/except in `tts_node` (`agent.py`), unguarded entrypoint startup — any one
   provider error kills the interview; a startup crash strands the session in
   `awaiting-call` forever.
4. Dead/fake UX: `PreCallReadyScreen`/`MicLevelMeter` never imported; `agentSpeaking`
   hardcoded `useState(false)` in `SessionRoomClient.tsx`.
5. The judge — producer of the product's only output — has no quality eval; only
   segmentation and schema shape are tested.
6. No session-quality telemetry: a "panel-pressure simulator" that never counts
   interjections, interruptions, or round durations.
7. Cost is measured but not enforced: session creation is unthrottled.
8. Stale security corpus entries test for leakage of the deleted relay-era prompt
   (`_LEAKED_PROMPT_TOKENS`, `tool-verify-false-claim`).
9. README/docs inflate or misstate: "150 audit cases" (real: ~53 at grill), traceparent
   "in the LiveKit JWT" (real: Firestore session doc), agent README's `interview-*`
   rooms + "Llama 3.3 70B" (real: `session-*` + gpt-oss-120b).

**Decisions locked with the user:**

| Question | Decision |
|---|---|
| Audience | Both: repo reviewers and live users |
| Observability sink | Langfuse free tier, fed by the existing OpenTelemetry pipeline |
| Approach | "Truth first, then muscle" — fix what lies, then resilience, then evals, then observability/protection |

## Phase 1 — Stop the lying

Everything a reviewer can falsify in minutes gets fixed. No new features.

- **Rewrite `docs/observability.md`** around the real architecture: traceparent via
  Firestore session doc, `agent.panel-session` parenting, `metrics_bridge` latency spans
  (including the honest partial-span policy), `SessionCostAggregator` → `estimatedCost`,
  current models and rates. Delete every RAG/transfer/verify-claim reference.
- **Fix `livekit-agent/README.md`**: `session-*` room pattern, gpt-oss-120b, accurate
  run instructions.
- **Fix main `README.md`**: traceparent claim, audit-size claim. Fix `docs/security.md`
  case-count claims.
- **Fix comment drift**: `latency_budget.py` min_delay reasoning (0.4 not 0.8),
  `lib/tracing.ts` propagation comment, `tracing.py` module docstring,
  `eval/README.md` renamed function/schema names.
- **Implement `checkBaselineModel`** in `eval/run.ts`: compare the baseline's recorded
  model id against the model the run used; on mismatch, fail with instructions to
  regenerate — never silently gate across models.
- **Regenerate `eval/baselines.json`** on `openai/gpt-oss-120b` (requires GROQ key,
  run locally).
- **Purge phantom security-corpus entries**: rewrite `_LEAKED_PROMPT_TOKENS` to tokens
  from the current panel prompt; retire or rewrite `tool-verify-false-claim` against the
  real tool surface (`next_round`, `end_interview`). Regenerate `security_baseline.json`.
- **Wire the mic pre-check**: `SessionRoomClient`'s inline pre-call screen is replaced by
  (or embeds) `PreCallReadyScreen` with the live `MicLevelMeter`, including the
  "we don't store audio" privacy line. Delete whichever component loses.
- **Real speaking indicator**: drive `agentSpeaking` from LiveKit active-speaker events
  instead of the dead `useState(false)`.

## Phase 2 — Live-path resilience

Rule: a provider error may degrade one turn, never kill the session.

- **LLM failover**: build one Groq LLM instance per configured API key (reusing
  `groq_keys.py` rotation) and wrap them in LiveKit's `llm.FallbackAdapter` in
  `pipeline.py`. A 429/timeout fails over instead of erroring the turn.
- **TTS error handling in `tts_node`** (`agent.py`): wrap each persona segment's stream;
  on error retry that segment once, then fall back to the round leader's TTS instance;
  log + span-event every fallback. A voice glitch becomes a cosmetic blip.
- **Guarded startup**: try/except around the entrypoint's
  `connect → init_firebase → load_session_data` sequence. On failure, best-effort mark
  the session (`status: "agent-start-failed"`, or leave breadcrumb metadata) and exit
  cleanly.
- **Reconciler sweep for stranded sessions**: `reconcile/route.ts` learns a third case —
  `awaiting-call` older than a stale window → `abandoned` (nothing was ever said;
  no report is manufactured).
- **Tests**: fallback adapter wiring, tts_node error → leader-voice fallback (mock
  streams), startup-failure marking, reconciler awaiting-call sweep.

## Phase 3 — Evals that impress

Two new suites; both reuse existing machinery. This is the showcase centerpiece —
simulation-based evaluation is the flagship practice in current voice-agent literature.

- **Judge eval** (`eval/judge/`): 4–6 golden transcript fixtures authored by hand
  (strong senior, weak junior, mixed, off-topic rambler) with expected per-round score
  ranges and expected `barVerdict`. Runner calls the real `judgeInterview` path
  (Gemini), asserts scores land in range, and measures run-to-run spread across 3 runs
  (consistency). Gate: any score outside range, or spread above threshold, fails.
- **Simulated-candidate eval** (`livekit-agent/.../evals/` or `security/`-adjacent):
  an LLM plays the candidate against the REAL panel prompt in a text-only loop
  (reusing `security/runner.py`'s chat plumbing). Personas: strong, rambling,
  adversarial. Deterministic assertions per transcript: every assistant utterance
  carries a valid speaker tag; interjection count per round ≤ intensity budget
  (calm 0 / standard 1 / grill 3); `next_round` only after the guard's minimum turns;
  no scores/verdicts uttered. Baseline file like the security audit's.
- **CI wiring**: both join `ci.yml` on the existing schedule/dispatch lane; PR-blocking
  where secrets allow (repo-local PRs), skip-clean otherwise. README describes the
  gating honestly — no "gates CI" claims for cron jobs.

## Phase 4 — Observe and protect

- **Langfuse**: point the existing OTel exporters (Python `tracing.py`, web
  `instrumentation.ts`) at Langfuse's OTLP endpoint via env
  (`OTEL_EXPORTER_OTLP_ENDPOINT` + basic-auth headers). Enrich LLM spans with
  `gen_ai.*` attributes (model, token counts) where the data already exists
  (metrics bridge, cost aggregator). Document the setup with screenshots in the
  rewritten `docs/observability.md`.
- **Session-quality telemetry**: the agent counts per-session interjections (non-leader
  speaker segments, from `panel_tts` speaker data), interruptions (LiveKit metrics),
  and per-round durations; persists a `qualityTelemetry` map onto the session doc at
  finalize (same durability path as `estimatedCost`).
- **Report-page stats strip**: duration, interjection count, cost, median turn latency —
  the panel-pressure product visibly measures panel pressure.
- **Rate limiting**: per-user daily session-creation quota enforced in
  `createPracticeSession` via a Firestore counter (fail closed on quota, clear error in
  the UI); optional global daily cap via env. No new vendor.

## Out of scope (parked)

Worker deploy automation (Dockerfile exists; CI deploy is follow-up), load testing,
avatars, BYOK, cross-session memory, a general frontend component-test suite (tests are
added only for components this work touches), the 17 npm moderates behind major bumps.

## Verification

- Per phase: `npx tsc --noEmit`, `npm test`, `npm run build`, `uv run pytest` all green.
- Phase 1: `git grep` proves no doc references deleted symbols (`rag`, `verify_cv_claim`,
  `lookup_cv_jd`, `transfer_to_`, old model ids); eval + security baselines carry the
  current model id.
- Phase 2: simulated provider-failure tests pass; manual kill-test during a live session
  once keys exist.
- Phase 3: both eval suites runnable locally with keys; recorded baselines committed.
- Phase 4: a real session's trace visible in Langfuse; `qualityTelemetry` present on the
  session doc; quota error surfaced in the UI when exceeded.
