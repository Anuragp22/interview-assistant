# JobVoice — Panel-Pressure Simulator

Product + architecture design. Answers every open question in `docs/HANDOFF.md` PART 2.

## Identity

**The only place to practice being grilled by multiple interviewers at once.**

The market has delivery coaches (Yoodli), live-interview copilots (Final Round AI), and
single-interviewer Q&A (Google Interview Warmup). Multi-interviewer pressure — people who
interrupt, probe from different angles, redirect your answer midstream — is named as a gap
in competitors' own content and served by nobody in real-time voice. JobVoice already owns
the hard part (multi-voice WebRTC infrastructure with barge-in); what it shipped was a
relay that never delivered the experience. This design closes that gap.

## Product decisions (locked 2026-07-16)

| Question (HANDOFF PART 2) | Decision |
|---|---|
| Why three agents at all? | The product needs three *interviewers*, not three *agents*. One agent roleplays the panel. |
| Relay vs panel | Panel. Interviewers share the room and can interject. The relay dies. |
| Pressure pedagogy | **Intensity dial** — Calm / Standard / Grill, chosen per session. Stress is opt-in; overwhelm is a setting, not a bug. |
| "No-hire" in a prep tool | Replaced by **"clear the bar"**: `advance \| not-yet` at the stated level, plus the single highest-leverage fix. Hiring vocabulary is gone; scoring rigour stays (a wrong readiness call still misleads). |
| Should the user choose their panel? | **Preset library** (3 in v1). The user picks context, never rubric content — no grading your own homework. |
| What is the loop? | **Beat the panel.** Bar-clearance per preset×intensity replaces the score sparkline. "Not yet" names one fix; the rematch button re-fills the same panel. |
| Is voice necessary? | Yes — under this identity, the pressure *is* auditory and interruptive. Text panels already exist and don't deliver it. |

## Architecture

**One `PanelAgent` roleplays the whole panel; TTS switches voice per utterance.**

- The LLM emits speaker-tagged utterances (`[SARAH] …`, `[ADAM] …`). An overridden
  `tts_node` parses the streaming text and routes each segment to that persona's
  ElevenLabs voice (one prewarmed TTS instance per persona). Tags are stripped from audio.
  Untagged or unknown-name text falls back to the current round leader's voice.
- Rounds survive as prompt structure: one persona leads each round; others interject
  within the intensity budget. `next_round` / `end_interview` are the only tools, guarded
  by the same min-turn preconditions (`TransferGuard`, slimmed).
- Rejected: real agent concurrency (`AgentSession` holds exactly one `current_agent`;
  arbitration unsolved; 3× cost) and a hybrid relay/roleplay split (two architectures for
  one product).
- Net effect: less code than the relay — three Agent subclasses, three handoff tools, and
  `currentPersonaId` resume machinery collapse into one Agent and a round counter.

### Intensity dial

Session field `intensity: "calm" | "standard" | "grill"`, prompt-enforced as an
interjection budget per round:

- **Calm** — leader only; zero interjections. Today's UX on the new architecture.
- **Standard** — ≤1 interjection/round; one follow-up, then yield; no pile-ons.
- **Grill** — ≤3/round; cross-examination; panelists may disagree with each other.

Budget overruns are a quality bug, not a security bug: counted post-hoc in telemetry
(non-leader segments per round), never blocked at runtime.

### Presets (v1)

`lib/presets.ts` is the source of truth; Python reads only the session doc.

1. **`big-tech-swe`** — Sarah/Adam/Bella, existing rubrics verbatim.
2. **`startup-generalist`** — founder + senior engineer; ownership/ambiguity focus;
   no system-design round.
3. **`new-grad-swe`** — fundamentals + behavioral; thin-CV tolerant (grounding falls back
   to JD + fundamentals when the CV is under 600 tokens — a full resume measures ~1,300).

Rubrics live in code, preset-scoped (`PRESET_RUBRICS[presetId][roundId]`), BARS 0–5
anchors unchanged. New presets require authored anchors — that is deliberate friction.

### Verdict + report

`judgeVerdictSchema`: `barVerdict: "advance" | "not-yet"` + `focusArea` (the one fix,
with evidence). The verdict call still never sees the raw transcript. Everything else in
the scoring pipeline is unchanged: evidence→rationale→score field order, ×3
criterion-rotation median, cross-family judge, low-confidence flag.

## Constraints that hold

- **No tone/affect/composure scoring.** Grill mode raises *question* pressure; how the
  candidate sounds under it is never scored (EU AI Act Art. 5(1)(f) posture unchanged).
- Speaker tags are parsed **only from LLM output**, never from user/STT text — spoken
  "bracket Sarah bracket" is inert. The security corpus gains cases asserting the model
  doesn't launder candidate-supplied tags.
- Firestore remains the sole cross-service contract.

## Non-goals (v1)

Free panel builder; adaptive difficulty; real agent concurrency; interview-date planning;
mic pre-check wiring (separate task); fairness harness (blocked on sourced SAE↔AAE
transform per HANDOFF).

## Acceptance

- One agent, three distinct voices in a live session; interjections only at
  Standard/Grill; Calm is indistinguishable from the old relay to the candidate.
- Report headline is the bar verdict; per-round evidence quotes unchanged.
- Dashboard shows clearance per preset×intensity with a rematch entry point.
- Full test suite + security audit green against the new tool surface.
