# JobVoice — state of the system, and the questions worth answering

This is not a changelog. It is what is true right now, and what nobody has
decided yet. The second half matters more than the first.

---

# PART 1 — FACTS

## What it is

An interview **prep** tool. A candidate uploads a CV, picks a role, joins a voice
call, and talks to three AI interviewers in sequence. At the end they get a
scored report.

Portfolio project, not a shipping product. One user. The bar is "everything here
works and every claim survives scrutiny."

## The shape

```
Browser ──WebRTC──▶ LiveKit Cloud ──dispatch──▶ Python worker (livekit-agent/)
                                                   │
                              Deepgram nova-3 ─────┤
                              Groq gpt-oss-120b ───┤   one AgentSession
                              ElevenLabs Flash ────┤   one active Agent
                              LiveKit TurnDetector ┘
                                                   │
                                    on call end: marks session awaiting-report
                                                   ▼
                              Gemini 3.1 Flash-Lite scores it
                                                   ▼
                                    Firestore ◀── everything
```

Two services, one repo, no direct RPC. They communicate **only** through
Firestore documents and a LiveKit room.

## The three interviewers

| | Persona | Round | Voice |
|---|---|---|---|
| 1 | Sarah | Behavioral (STAR probes) | ElevenLabs `EXAVITQu4vr4xnSDxMaL` |
| 2 | Adam | Technical (implementation depth) | `pNInz6obpgDQGcFmaJgB` |
| 3 | Bella | System design (constraints, trade-offs) | `hpp4J3VqNfWAUOO0d1Us` |

They are **sequential, not concurrent**. Sarah runs ~3–6 turns, calls
`transfer_to_technical`, and Adam replaces her. It is a relay, not a panel.

**Hard constraint:** `AgentSession` holds exactly one `current_agent`.
`update_agent()` swaps it. The SDK has no concept of two agents live at once.
Anything simultaneous must be built on top of that, not configured into it.

Personas are **prompt-level, not architectural**. Each is a system-prompt template
+ a voice id + a rubric. The only thing that makes them separate `Agent` subclasses
is that TTS is bound per-Agent so the voice changes on swap.

## Scoring

Runs offline, after the call, on **Gemini 3.1 Flash-Lite** — a different model
family from the interviewer, so the interviewer's blind spots aren't also the
grader's.

- Transcript is segmented by `personaId` (stamped on every turn).
- Each round scored against **its own rubric** — behavioral criteria for Sarah's
  round, technical for Adam's, system design for Bella's.
- **0–5 with behavioural anchors** (`lib/rubric.ts`). LLM judges cannot
  discriminate 100 levels; ~5-point anchored scales track human raters best.
- Schema field order is `evidence` → `rationale` → `score`. Structured decoding
  fills fields in order, so the model must quote the transcript and reason before
  it can emit a number.
- Scored **3× with the rubric criteria rotated**, median taken. Criterion order
  alone moves LLM scores by up to 0.8 points on a 5-point scale.
- The recommendation is a **separate call** that sees only the finished scores,
  never the raw transcript.
- Report shows the verbatim quotes behind every score, and flags low confidence
  when the 3 runs disagreed by ≥2 points.

Cost: **~$0.35 per 100 interviews.**

## What it deliberately does not do

- **No tone, affect, confidence, or emotion scoring.** Inferring emotion in a
  hiring context is a prohibited practice under EU AI Act Art. 5(1)(f) — in force
  since Feb 2025, €35M / 7% of turnover. This is why HireVue removed facial
  analysis (it was worth ~0.25% of predictive power).
- **No "Cultural Fit" score.** Canonical proxy for protected-class discrimination.
- **No accent, dialect, or fluency scoring.** The judge is told this explicitly.
- **No RAG.** The CV is 1,300 tokens (measured, real CV). Full system prompt is
  2,004. Retrieval over that is solving a context-window problem that doesn't
  exist.
- **No cosine-similarity claim checking.** It measures topical relatedness, not
  entailment. "I led the migration" and "I attended a meeting about the migration"
  are near-identical vectors and opposite truths.

## Numbers that are real (measured, not estimated)

| | |
|---|---|
| CV in prompt | 1,300 tokens |
| Full system prompt | 2,004 tokens |
| CV overhead per session | ~$0.006 (≈2% of what TTS costs) |
| LLM input, 30-turn session | ~112k tokens ≈ $0.017 |
| Judge | ~$0.0035/interview |
| Turn detector false-cutoff | 9.9% @ 300ms (VAD-only: ~27.7%) |
| Tests | 132 Python, 42 web, `tsc` clean |

## Deadlines and gates

- **Groq decommissions `llama-3.3-70b-versatile` 2026-08-16.** Already migrated
  off it. Do not migrate back.
- `openai/gpt-oss-20b` and `gpt-oss-120b` are the **only** Groq models with strict
  `json_schema`. Not Llama 4, not Qwen3, not Kimi K2.
- LiveKit's text turn detector (`MultilingualModel`/`EnglishModel`) is deprecated
  and removed in Agents 2.0. The audio `TurnDetector` is the current API and needs
  `livekit-agents ≥1.6.1`.
- ElevenLabs Turbo is deprecated; Flash is the replacement at the same price.

## Not proven

**No live interview has ever been run.** The Gemini judge has never made a real
API call. The TurnDetector has never processed real audio. The agent→score ping
has never fired. The cron reconciler has never run. Nothing is deployed.

Everything above rests on unit tests, type checks, and vendor docs.

## Blocked on the human

- `GEMINI_API_KEY` **with billing enabled** — the free tier trains on submitted
  content, and this call carries candidate CVs and transcripts.
- `INTERNAL_API_SECRET`, `CRON_SECRET`, `WEB_APP_URL`.
- Both baselines still record `llama-3.3-70b-versatile` and need regenerating.
- `eval/run.ts → checkBaselineModel()` is a deliberate stub.

## Load-bearing decisions that look like bugs

- `endpointing.min_delay` is **0.4s, down from 0.8s**. Not less patience — the
  0.8s was padding for VAD's blindness; the audio detector now makes that call and
  `min_delay` is just a floor. Raising it back re-adds a per-turn latency tax.
- **The latency p95 will look worse than the old dashboard.** The old one silently
  dropped partial metrics, which came from interrupted and tool-call turns — i.e.
  disproportionately the slow ones. The budget always looked met because the
  violations weren't in the data.
- `TransferGuard` exists **only** to protect the handoff tools. If the panel
  design changes, ask whether it still has a job.

---

# PART 2 — THE OPEN QUESTIONS

**Update 2026-07-16: the questions below were answered and built** — see the
answer notes under each heading and the design spec at
docs/superpowers/specs/2026-07-16-panel-pressure-simulator-design.md. The original
reasoning is preserved because it documents WHY each decision fell the way it
did.

Nothing below was decided when first written. Some of it questions work that is already built.

## Why three agents at all?

> *Answered 2026-07-16: wrong question — the product needs three INTERVIEWERS, not three agents. One PanelAgent roleplays the panel. See docs/superpowers/specs/2026-07-16-panel-pressure-simulator-design.md.*

The honest case against, stated as strongly as possible:

This is **interview prep**. One user, practising. The value is (a) reps under
pressure and (b) finding out what they're bad at. A single agent could ask every
one of the same questions, using the same three rubrics, and produce the same
report. The personas are prompt-level — nothing about them requires separate
`Agent` instances except that TTS is bound per-Agent.

What the panel costs today: handoff latency, an entire prompt-injection attack
surface (`TransferGuard` exists for nothing else), resume complexity,
`currentPersonaId` persistence, three voice configs, and a chunk of the codebase.

What it buys: three voices instead of one, and a transcript segmented by round —
though a single agent could tag its own rounds just as well.

**So: is the panel a product feature, or is it a demo that survived into
production?** Answer it honestly. "It's more realistic" is a claim, not an
argument — real onsite loops are multi-interviewer, but they're also multi-*day*,
and nobody's simulating that.

If the answer is "cut it," a lot of complexity goes with it. If the answer is
"keep it," the next question gets sharper.

## It is a relay, not a panel

> *Answered 2026-07-16: built option 1 — one agent roleplaying the panel with per-utterance TTS voice routing, plus an intensity dial (Calm/Standard/Grill) governing an interjection budget.*

"Panel" implies people in a room together. What exists is three interviews back
to back. Sarah leaves before Adam arrives. They never interact. The candidate
never experiences the thing the word "panel" describes.

The user's instinct — *"they grill at once, like suddenly if one waits"* — is
pointing at the actual product. Being cross-examined by three people who can each
interject is a genuinely different experience from three sequential interviews,
and it is the one that's hard to practise anywhere else.

Three ways to build it, roughly in order of ambition:

1. **One agent roleplaying three.** The LLM writes `[ADAM] ...` / `[BELLA] ...`,
   and TTS switches voice per line. Architecturally trivial — one prompt, one
   session, no arbitration. Gets you interjections, disagreement between
   interviewers, follow-ups that build on each other. Fake, but the candidate
   can't tell.
2. **Real concurrency.** Multiple agent instances in the room, some arbiter
   deciding who speaks. `AgentSession` won't do this — one `current_agent`, full
   stop. Would need agents outside the session abstraction, and then: who decides
   who talks? What happens when two start at once? Barge-in between *agents*, not
   just candidate→agent.
3. **Interjection budget.** Keep the sequential spine, but let the other two
   interrupt occasionally. "Sorry, before you move on — Adam here. You said
   Redis. Why not Postgres?" Cheap to fake with option 1's mechanics.

Worth asking: **is being grilled by three at once actually good for prep?** It's
more stressful. That might be exactly the point (stress inoculation for the real
thing), or it might be bad pedagogy (you learn less when overwhelmed). That's an
empirical question nobody has asked.

## Why is a prep tool emitting "no-hire"?

> *Answered 2026-07-16: it isn't any more. The verdict is "clear the bar" (advance | not-yet) + the one highest-leverage fix. All scoring rigour survived; only the vocabulary died.*

The report currently ends with
`recommendation: strong-hire | hire | lean-hire | lean-no-hire | no-hire | inconclusive`.

That is a **hiring tool's output**, in a **prep tool**. Nobody is being hired. The
user is practising. Telling someone "no-hire" is demoralising and not actionable —
it answers a question they didn't ask.

What a prep user actually wants: *what do I fix before Thursday?* The evidence
quotes and per-criterion scores already answer that. The recommendation might be
the least useful thing on the page — and it's the thing that carries all the legal
weight and bias risk.

Possibilities: drop it. Replace it with "you'd likely clear a bar at X level."
Replace it with the single highest-leverage thing to work on. Reframe the whole
report as coaching rather than verdict.

But notice the tension: the *scoring rigour* (BARS anchors, permutation
averaging, cross-family judge, bias resistance) was built to make a hiring-grade
judgement defensible. If this is prep and there's no verdict, some of that rigour
is insurance against a risk that doesn't exist. Some of it isn't — a wrong score
still misleads someone about their own weaknesses.

**Which parts of the rigour survive if the verdict goes?**

## Should the user choose their panel?

> *Answered 2026-07-16: preset library (big-tech-swe / startup-generalist / new-grad-swe). Users pick context, never rubric content.*

Fixed today: Behavioral → Technical → System Design. That's a generic FAANG loop.
It is wrong for a startup interview, a data role, a PM role, a new grad, an SRE.

A prep user knows exactly what they're walking into. They can say "two technical
rounds and a hiring manager," or "I'm interviewing at a 20-person startup, no
system design, heavy on ownership."

Under the hood a persona is already just `{name, voice, expertise_area, rules,
rubric, questions}`. Making that user-configurable is not a rewrite. The hard part
isn't the mechanism — it's:

- How much configuration before it's a burden rather than a feature?
- If the user picks the rubric, is the score still meaningful, or did they just
  grade their own homework?
- Does a preset library ("Google L5 backend", "Series A startup", "FAANG new
  grad") beat free configuration?

## What is the loop?

> *Answered 2026-07-16: beat the panel — bar-clearance tracked per preset×intensity, rematch links to the next heat. The sparkline is gone.*

Nobody has articulated why someone comes back a second time.

The dashboard has a score sparkline, so the implied answer is "watch your number
go up." That's a weak loop — the score is noisy (the judge disagrees with itself
by up to 2 points on the same transcript), and a number going up doesn't teach
anyone anything.

Stronger candidates for the loop:
- **Same question, second attempt.** Did the answer actually get better? That's
  the only measurement here that's controlled.
- **Weakness targeting.** "Your system design round is 2.1/5 and your behavioral
  is 4.2 — here are three more system design rounds."
- **Spaced repetition on your own weak spots.**
- **Prep for a specific interview on a specific date**, with a countdown.

The report is currently a **terminal artifact** — you read it and leave. Nothing
in the product routes you back in.

## Questions under those questions

- **Is 30 minutes right?** The turn ceiling is 30. Nobody validated that against
  what a prep user will sit through, or what's enough to score reliably.
- **Does the candidate know how they're being judged?** The rubric is invisible to
  them during the call. Showing it would be honest and might improve the practice
  — or might turn it into rubric-gaming, which is what real interviews suffer from.
- **What happens when the CV is thin?** A new grad's CV is 400 words. The
  questions are grounded in it. Grounded in what?
- **Is voice even necessary?** Voice is expensive (~$0.30/session in TTS alone,
  vs $0.017 for the LLM) and it's the whole architecture. Sapia.ai deliberately
  runs text-only *to avoid* accent bias. For prep specifically, is the voice the
  product, or is it a demo of voice tech?
- **The name says "panel." Does the product deliver a panel?** Right now, no.

## The thing to be most suspicious of

The CI file's own header says: *"This file makes the resume claims literally
true."* That is an honest sentence about what this codebase optimised for.

Several subsystems were built to be **describable** rather than **load-bearing**.
The three-agent panel is the biggest one and it is worth interrogating hardest:
until recently the judge never even read `personaId`, so the panel existed during
the call and vanished from the only output anyone acts on. It cost latency, an
attack surface, and complexity — and contributed nothing to the report.

That's fixed. But the question it raises isn't fixed: **what else is here because
it sounds good?**

---

## Where things live

- `lib/rubric.ts` — the BARS anchors. The scoring contract. Read first.
- `lib/llm/judge-report.ts` — segment → score ×3 → median → verdict.
- `lib/judge.ts` — Gemini provider; the different-family reasoning.
- `livekit-agent/src/interview_agent/persona.py` — the three personas, prompts,
  voices. Where a panel redesign starts.
- `livekit-agent/src/interview_agent/pipeline.py` — AgentSession + turn handling.
- `livekit-agent/src/interview_agent/models.py` — every model id, one place.
- `livekit-agent/src/interview_agent/agent.py` — the three Agent subclasses,
  handoff tools, entrypoint.
- `constants/index.ts` — judge schemas.
- `docs/superpowers/**` — dated design archive. Historical. Do not treat as current.
- `docs/{ARCHITECTURE,TECH_DECISIONS,INTERVIEW_PREP}.md`, `ONBOARDING.md` — **stale.**
  They describe RAG, llama-3.3, nova-2, the deleted HR flow. README is current.

## Known unfinished

- **Mic pre-check exists but isn't wired.** `MicLevelMeter` +
  `PreCallReadyScreen` sit in `components/practice/`. Candidates currently join a
  voice interview with zero mic verification.
- **Nothing evaluates the judge.** `eval/` gates question generation — the
  cheapest LLM call in the system. The score and the recommendation, which are the
  only outputs anyone acts on, have no eval at all.
- **The fairness harness doesn't exist.** The design: take a fixed transcript,
  apply semantically-null perturbations (criterion reorder, paraphrase, name-swap,
  length-pad, SAE↔AAE dialect transform), assert the score doesn't move. Score
  change under a null perturbation *is* the bias metric.

  Why it matters: ASR degrades transcripts for Black and accented speakers (WER
  0.35 vs 0.19, and the gap persists on *identical phrases* — Koenecke et al.,
  PNAS 2020). The judge then penalises the dialect-marked transcript — models given
  African American English assign less-prestigious jobs, and RLHF masks rather than
  removes it (Hofmann et al., *Nature* 633:147, 2024). Off-the-shelf LLM scoring
  already fails the four-fifths rule (GPT-4o impact ratio 0.774; every model tested
  failed on intersectional race×gender — arXiv 2507.02087). The failure compounds
  and essentially nobody in the industry measures it.

  Report Cohen's κ, never raw agreement — raw agreement of 0.80–0.85 overstates κ
  by 33.8–41.2 points. Expect κ ≈ 0.38–0.51 and say so.

  ⚠️ **The SAE↔AAE transform must not be improvised.** Sourced from linguistics
  literature it's real work. Invented ad-hoc it's a caricature generator with the
  author's name on it.
