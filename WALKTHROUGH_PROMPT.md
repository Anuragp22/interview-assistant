# Prompt — build the animated JobVoice walkthrough

Paste everything below the line into Claude Code **while inside the `interview-assistant` repo**.
(Or just say: *"follow WALKTHROUGH_PROMPT.md"*.)

Delete this file afterwards if you don't want it tracked.

---

Build a single-file animated walkthrough of THIS repository — `docs/jobvoice-motion.html` — the way
a staff engineer would explain the system to a smart newcomer: real Framer Motion, three acts, every
claim traceable to actual code.

## Phase 0 — Verify before you animate (non-negotiable)

Do NOT write a line of the page until you have read the code. Every number, model name, threshold,
file path, function name, and default in the finished page must be something you personally read in
this repo. If you cannot point to `file:line` for a claim, it does not go in the page.

**This repo is unusually well documented — and that is a trap.** `README.md`, `docs/ARCHITECTURE.md`,
`docs/TECH_DECISIONS.md`, `docs/GLOSSARY.md`, `docs/security.md`, `docs/observability.md`, and
`docs/resumable-sessions.md` are an excellent starting map, but they are **claims to verify, not
sources of truth**. Read them first to orient, then confirm each against the implementation. Where a
doc and the code disagree, the code wins and you tell me about the drift.

Treat `docs/superpowers/plans/` and `docs/superpowers/specs/` as **design-phase history**. They are
dated and several predate the shipped architecture (the multi-agent-relay spec vs. the single
PanelAgent that actually shipped, for instance). Use them to understand *why* a decision was made —
never as a description of what exists now.

Where the substance lives (CONFIRM each, correct what's wrong, add what's missing):

- **Realtime agent (Python):** `livekit-agent/src/interview_agent/` — `agent.py`, `pipeline.py`,
  `panel_tts.py` (the `tts_node` voice routing), `persona.py`, `session_data.py`, `hooks.py`,
  `models.py`, `groq_keys.py`, `latency_budget.py`, `metrics_bridge.py`, `cost_aggregator.py`,
  `tracing.py`, `security_guards.py`, `persistence/firestore.py`, `reporting.py`
- **Security + injection:** `security/injection_corpus.py`, `security/runner.py`,
  `security/run_audit.py`, `livekit-agent/security_baseline.json`
- **Eval harness (both sides):** `eval/` (`run.ts`, `fixtures.ts`, `baselines.json`,
  `baseline-check.ts`, `judge/gate.ts`, `judge/run.ts`, `scorers.ts`, `latency-report.ts`,
  `report-model.ts`) and `livekit-agent/src/interview_agent/evals/` (`run_sim.py`,
  `simulated_candidate.py`)
- **Web app:** `app/(practice)/` routes (new → pre-call → interview → report),
  `app/api/sessions/[id]/livekit-token/route.ts`, `app/api/internal/score/route.ts`,
  `app/api/internal/reconcile/route.ts`, `components/practice/*`
- **Server logic:** `lib/judge.ts`, `lib/rubric.ts`, `lib/presets.ts`, `lib/clearance.ts`,
  `lib/quota.ts`, `lib/cost-rates.ts`, `lib/reconcile-staleness.ts`, `lib/role-resolution.ts`,
  `lib/grounding-passthrough.ts`, `lib/cv-parse.ts`, `lib/llm/*`, `lib/tracing.ts`,
  `firestore.rules`
- **Tests as specification:** `tests/` and `livekit-agent/tests/` — these encode the invariants far
  more precisely than prose. Read them.

**Read the git log carefully — it is the best material in this repo.** Almost every recent commit is
a `fix(eval)` / `fix(privacy)` / `fix(security)` that encodes a now-load-bearing design decision:
the sim gate failing when the panel never leaves round 1; the verdict checker no longer
false-positiving on round-advance wording; model-mismatch exiting 2 (couldn't run) rather than 1
(regression); compare mode failing when a fixture went unmeasured; a flaked fixture being *excluded,
not zeroed*; the integrity rule hardened against prompt extraction; round boundaries preserved when
`next_round` arrives tool-only; single-speaker audio streamed during generation rather than after.
Each of those is a "why it works this way" panel, and showing the naive version beside the fix is
the single most instructive thing this page can do.

Report what you verified before building, and flag any doc/code drift you found.

## What to build

`docs/jobvoice-motion.html` — ONE self-contained file, no bundler, no build step. Opened via a local
static server it must just run. It must not import from `app/`, `lib/`, or `components/` — it is a
standalone explainer, not part of the Next.js app, and it must not end up in the Next build.

**Stack, exactly:** an importmap pointing at esm.sh for `react@18`, `react-dom@18`,
`framer-motion@12`, and `htm`. Use `htm.bind(React.createElement)` — there is no JSX here. Include
a `<div id="boot">` fallback plus `window.onerror` / `unhandledrejection` handlers that print a
readable failure with a checklist, so a CDN hiccup shows a message instead of a blank page.

**Three acts, switchable, each with its own stage rail:**

1. **The panel is live** — the realtime loop, one turn at a time: browser joins the LiveKit room
   (token issue → agent dispatch) → candidate speaks → STT → end-of-utterance detection decides the
   turn is *actually* over → the LLM produces speaker-tagged lines → `tts_node` routes each
   utterance to that panelist's voice → audio streams back while still generating. Then the
   structural layer on top: presets and intensity shaping who is in the room and how hard they
   push, round advancement via `next_round`, and the guard that keeps a round boundary honest.
   Show latency where it actually accrues — this is a voice product and the turn budget is the
   whole user experience.
2. **After the call — scoring, and being fair about it** — the call ends and the session is marked
   awaiting-report → the judge scores each round **against that round's own rubric** → the report
   answers the question the user actually has (*would this panel have advanced me, and what is the
   one thing to fix first?*). Then the surrounding correctness: resumable sessions and
   reconciliation (including the abandon race), quota and clearance, and cost accounting per
   session.
3. **How it's kept honest** — the strongest act, and the one most walkthroughs would skip: the eval
   harness on both sides (fixtures → simulated candidate → scorers → judge gate → baselines →
   compare mode), what the gate's exit codes mean and why *couldn't-run* must not look like
   *regression*, why a flaked fixture is excluded rather than zeroed; the prompt-injection corpus
   and audit runner with its committed baseline; and the privacy work — CV, JD, and transcript
   content redacted out of AI SDK telemetry and LiveKit's exported agent spans.

**Every stage is a two-column panel:** left = the animated mechanism; right = a "why it's built this
way" box in prose a newcomer can follow, ending with the honest limitation. The limitation bullets
are mandatory — a walkthrough with no stated weaknesses reads as marketing. Real ones exist here:
one agent roleplaying N interviewers has failure modes a relay wouldn't; an LLM judge scoring an LLM
panel has obvious circularity worth naming; STT mis-transcription is invisible to the score; a
signature-based injection corpus only catches what's in it.

**Interactivity that teaches, not decoration.** At minimum:
- an **intensity** control (Calm / Standard / **Grill**) that visibly changes interjection and
  cross-examination behavior in act ①;
- a **panel preset** picker (big-tech loop / early-startup / new-grad) that changes who is in the
  room and which rubric each round is scored against;
- an **adversarial input** injector: the candidate *says* a speaker tag out loud, and a prompt-
  extraction attempt — showing why tags are parsed only from LLM output and what the integrity rule
  does. This is a real property of the system; make the viewer watch it fail to work.
- an **eval outcome** toggle in act ③: pass / regression (exit 1) / couldn't-run (exit 2).

**Framer Motion, used properly** — not just fades:

- `layout` / FLIP for structural change (a turn entering the transcript, rounds advancing)
- `AnimatePresence` for exits — a speaker yielding, a fixture dropping out of a run
- `layoutId` for one shared element that flies between rail nodes
- variants + `staggerChildren` for cascades driven by one state change
- `useSpring` / motion values for scroll, progress, and any audio-level or latency meter
- for the turn loop, make the *timing* legible — a viewer should feel where the seconds go

**Newcomer glossary** near the top: STT, TTS, EOU/turn detection, SFU/WebRTC, barge-in, BARS rubric,
LLM-as-judge, eval fixture, baseline, regression gate, prompt injection, span/telemetry redaction,
and any term the page uses without defining.

## Accuracy rules (these are where such pages usually go wrong)

1. **Never animate a sequence that contradicts execution order.** If TTS streams *during* generation
   rather than after, do not animate generate-then-speak — that ordering was a deliberate fix and
   reversing it teaches the bug. Sequence on screen must match sequence in code.
2. **Use real values.** Real model names and versions, real rubric dimensions, the real turn budget,
   the real exit-code semantics, real field names. No invented metrics, no placeholder "0.87". If a
   baseline number is in `eval/baselines.json`, use that number or none.
3. **Label illustrative content as illustrative.** Sample transcript lines must be obviously
   synthetic, and marked as such.
4. **Never use real candidate data.** No real CV text, no real JD, no real transcript, no real
   session ids, no names of actual people. Given that redacting exactly this content from telemetry
   is one of the things the page is *about*, leaking it into the page would be self-refuting.
5. **No secrets.** No API keys, LiveKit URLs, project ids, or `.env.local` values. Show shape, not
   content. Do not read `.env.local` into the page.
6. **Don't overstate the eval.** Report what the harness actually measures and what it doesn't. The
   honest framing is the selling point here — the git history already shows this project chose
   accuracy over flattering numbers, so match that voice.
7. **Where the system is weak, say so** — in the panel, in the same voice as the rest.

## Technical gotchas that will bite you

- **`htm` does NOT decode HTML entities.** `&amp;`, `&lt;`, `&nbsp;` render as literal text inside
  a template. Write `&` directly. For a literal `<` — which htm would otherwise parse as a tag —
  push it through an interpolation: `${"<turn>"}`, `${"<"}`. Use `${"  "}` instead of `&nbsp;`.
- Speaker tags like `[SARAH]` are fine in htm text, but if you ever need literal braces or angle
  brackets in a code sample, interpolate them.
- Theme-aware: honor `prefers-color-scheme` AND a `data-theme` toggle that wins in both directions.
- Wide content (transcripts, tables, code, timelines) scrolls inside its own `overflow-x:auto`; the
  body must never scroll sideways.
- Keep the rail readable if a stage list grows past ~10 nodes.
- When searching the repo, exclude `node_modules/`, `.next/`, and `package-lock.json` — they will
  drown every grep.

## Phase 2 — Verify it actually works (do not skip, do not claim without evidence)

1. Extract the module script and run `node --check` on it. A single unbalanced backtick in an htm
   template silently kills the entire page.
2. Serve the folder (`python -m http.server`) and load it in a real browser.
3. **Sweep every stage of every act programmatically** — click each rail node, and for each panel
   assert: no literal `&amp;` / `&lt;` / `&gt;` / `&nbsp;` in the rendered text, panel is not empty,
   console has no errors.
4. Verify each interactive control actually changes downstream state — intensity, preset,
   adversarial injector, eval outcome — by sampling the DOM at timed intervals, not by assuming.
5. Grep the finished file for anything that looks like a key, a real email, or a real session id
   before you call it done.
6. Report the sweep results. If something fails, fix it and re-run. Only claim it works after you
   have seen it work.

Then clean up any screenshots or scratch artifacts, and tell me exactly which files changed.
