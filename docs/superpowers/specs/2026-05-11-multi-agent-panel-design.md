# Multi-Agent Interview Panel — Design Spec

**Date:** 2026-05-11
**Status:** Approved (brainstormed inline)
**Predecessor:** [Practice Mode](./2026-05-11-practice-mode-design.md)

## 1. Goal

Replace the single `GeneralInterviewer` Agent with a 3-agent panel that hands off between specialists via LiveKit Agents 1.5's native supervisor pattern. The candidate audibly hears the voice change at hand-off; each agent owns a different round (Behavioral → Technical → System Design) with its own questions, rules, and TTS voice.

This is a depth play, not a feature add. The audio loop, RAG, fact-check tool, turn persistence, and report generation are all reused. What changes: persona structure, question-generation output shape, agent code (1 → 3 subclasses), and a small transcript-view enhancement.

### 1.1 Acceptance criteria

A signed-in practice user starting a new session:

1. Lands in the live interview with the **Behavioral** agent speaking first (Sarah voice).
2. After a natural exchange (~3-6 turns), the agent calls `transfer_to_technical`; the candidate hears a new voice (Adam) introducing himself as the technical interviewer.
3. Same again after the technical round → System Design (Bella voice).
4. The System Design agent calls `end_interview` when done; the session moves to `completed` and the report renders.
5. The report shows the standard 5-category breakdown unchanged. The transcript view shows a small persona badge per turn (Behavioral / Technical / System Design / You) so the recruiter (or the practising user) can see which agent asked what.
6. `verify_cv_claim` and `lookup_cv_jd` work in every round — they're inherited by all three agents.
7. Total interview length: typically 15-25 min. Hard ceiling: 30 turns. Per-agent soft cap: ~8 turns (prompt-driven, not enforced in code; an agent that doesn't transfer after 8 turns gets a "transfer now" nudge in its rules).

### 1.2 Out of scope (v1 of multi-agent)

- Recruiter-configurable panel (different role types map to different panels)
- Per-round score breakdown in the report (the 5-category report covers what matters; revisit later)
- Parallel agents / panel discussion (one agent active at a time — LiveKit Agents only swaps the active one)
- Resuming mid-panel from a fresh tab
- A 4th culture-fit agent (covered by Behavioral in practice)

## 2. Architecture

### 2.1 Agent hierarchy

```
InterviewerBase(Agent)
  - common tools: lookup_cv_jd, verify_cv_claim
  - shared __init__ takes (instructions, index, session_id, persona)

BehavioralInterviewer(InterviewerBase)
  - voice: Sarah
  - questions: session.questionsByPersona.behavioral
  - tool: transfer_to_technical -> TechnicalInterviewer

TechnicalInterviewer(InterviewerBase)
  - voice: Adam
  - questions: session.questionsByPersona.technical
  - tool: transfer_to_system_design -> SystemDesignInterviewer

SystemDesignInterviewer(InterviewerBase)
  - voice: Bella (premade ElevenLabs "Grace")
  - questions: session.questionsByPersona.systemDesign
  - tool: end_interview
```

`agent.py#entrypoint` constructs the index, then starts the session with `BehavioralInterviewer` as the active agent. LiveKit Agents 1.5's `AgentSession` swaps the active agent in place when a `@function_tool` returns a new Agent instance.

### 2.2 Per-Agent TTS

Each Agent subclass constructs its own ElevenLabs TTS in `__init__` from its persona's voice config. LiveKit Agents 1.5 supports passing `tts=` to the Agent constructor — the session uses the active Agent's TTS provider, swapping when the active Agent swaps. `pipeline.build_session()` no longer takes a TTS arg.

### 2.3 Hand-off semantics

Each Agent's `transfer_to_<next>` tool returns the next Agent instance, instantiated with the same `index`, `session_id`, and its own persona's instructions. The chat history (the candidate's previous answers + the previous agent's questions) is preserved by `AgentSession` automatically.

Hand-off triggers are prompt-driven (per the brainstorm decision). Each persona's `rules` end with:

> "You are part of a 3-interviewer panel. After ~3-6 substantive turns of dialogue, call `transfer_to_<next>` to hand the candidate off to the next interviewer. After 8 turns you MUST transfer regardless of signal — a long interview burns candidate energy and dilutes the panel structure."

A hard ceiling on total session turns (30) is enforced in code as a safety net: when reached, the session closes regardless of agent state.

### 2.4 Why not LangGraph

LangGraph would add a separate orchestrator process or in-process state machine for routing. LiveKit Agents 1.5's native hand-off is in-audio-loop (zero added latency), preserves chat history automatically, and supports per-Agent TTS swap. For a sequential interview panel — strictly better.

## 3. Personas

`livekit-agent/src/interview_agent/persona.py` extends the `Persona` dataclass and ships three persona constants.

### 3.1 Extended `Persona` dataclass

```python
@dataclass(frozen=True)
class Persona:
    id: str
    name: str
    expertise_area: str
    voice_id: str
    voice_stability: float
    voice_similarity_boost: float
    voice_speed: float
    voice_style: float
    voice_use_speaker_boost: bool
    system_prompt_template: str
    rules: str
    next_persona_id: str | None  # "technical" -> "system-design" -> None
```

### 3.2 Three persona constants

| Field | BEHAVIORAL_PERSONA | TECHNICAL_PERSONA | SYSTEM_DESIGN_PERSONA |
|---|---|---|---|
| `id` | `"behavioral"` | `"technical"` | `"system-design"` |
| `name` | Sarah | Adam | Bella |
| `expertise_area` | behavioral interviewer (STAR-framework probes) | senior technical interviewer | senior systems engineer |
| `voice_id` | `EXAVITQu4vr4xnSDxMaL` | `pNInz6obpgDQGcFmaJgB` | `oWAxZDx7w5VEj9dCyTzz` |
| `voice_stability` | 0.4 | 0.5 | 0.5 |
| `voice_similarity_boost` | 0.8 | 0.85 | 0.8 |
| `voice_speed` | 0.9 | 1.0 | 0.85 |
| `voice_style` | 0.5 | 0.3 | 0.4 |
| `voice_use_speaker_boost` | True | True | True |
| `next_persona_id` | `"technical"` | `"system-design"` | `None` |

### 3.3 Per-persona rules (appended to COMMON_RULES)

Behavioral:
> Use the STAR framework: probe for Situation, Task, Action, Result. If a candidate stops at the surface, ask one follow-up to get to the action or result. Don't ask theoretical "what if" questions — anchor in real past experience from the candidate's CV.

Technical:
> Push on concrete implementation details: data structures used, time complexity reasoning, code-level trade-offs. Ask "why" more than "what". If the candidate gives a high-level answer, ask them to walk through a specific decision they made.

System Design:
> Begin with constraints and assumptions before the candidate draws anything. Force them to articulate at least one bottleneck and one trade-off. Probe scalability + failure modes once the happy path is sketched.

### 3.4 Hand-off rule (appended to all three personas)

> You are part of a 3-interviewer panel. After ~3-6 substantive turns of dialogue with the candidate, call `transfer_to_<next>` (or `end_interview` for the last agent) to move the panel forward. After 8 turns you MUST transfer regardless of signal — a too-long single round dilutes the panel structure. Do NOT announce the hand-off as a separate utterance — the next interviewer will introduce themselves naturally when activated.

## 4. Data model

### 4.1 Session schema additions

`types/index.d.ts` extends `Session` with optional new fields:

```ts
interface Session {
  // ... existing fields stay
  questionsByPersona?: {
    behavioral: string[];
    technical: string[];
    systemDesign: string[];
  };
  rubricsByPersona?: {
    behavioral: RubricGrounded[];
    technical: RubricGrounded[];
    systemDesign: RubricGrounded[];
  };
}
```

The existing flat `questionsGrounded` / `rubricsGrounded` stay on the type as optional for backwards compatibility. New sessions written by `createPracticeSession` populate ONLY the new partitioned fields. Old sessions keep their flat fields and won't be playable by the new agent (they 404 with a toast — see §6).

### 4.2 Turn metadata

The existing `personaId` field already exists on turn metadata; it was always `"general"`. New runs write `"behavioral"` | `"technical"` | `"system-design"` depending on which Agent was active when the turn fired.

## 5. Generation pipeline

### 5.1 Phase 1 — partitioned generation

`lib/llm/groq-template.ts` gains a new export `generatePartitionedQuestions({role, level, jobDescription})` that returns:

```ts
{
  behavioral: { questions: string[]; rubrics: RubricBase[] };
  technical: { questions: string[]; rubrics: RubricBase[] };
  systemDesign: { questions: string[]; rubrics: RubricBase[] };
}
```

Single Groq call, `json_object` mode, prompt asks for `~3 questions per persona`. Schema definition added to `constants/index.ts` (`partitionedTemplateSchema`).

The existing `generateQuestionsAndRubrics` stays for the dormant HR-flow code path; we don't remove it.

### 5.2 Phase 2 — partitioned reground

`lib/llm/groq-grounding.ts` gains `regroundPartitionedQuestions({questionsByPersona, rubricsByPersona, jobDescription, cvText})` returning:

```ts
{
  behavioral: { questionsGrounded: string[]; rubricsGrounded: RubricGrounded[] };
  technical: { ... };
  systemDesign: { ... };
}
```

Single Groq call (same shape as the flat reground but grouped). New schema `partitionedGroundingSchema` in `constants/index.ts`.

### 5.3 `createPracticeSession` rewires

`lib/actions/practice.action.ts#createPracticeSession`:

1. Phase 1: `generatePartitionedQuestions(...)` → 3 buckets of base questions + rubrics
2. Template doc writes the flat versions (concatenated) for the HR-flow compatibility — `questionsBase = behavioral.questions ++ technical.questions ++ systemDesign.questions`
3. Phase 2: `regroundPartitionedQuestions(...)` against the saved CV
4. Session doc writes BOTH:
   - `questionsByPersona` + `rubricsByPersona` (new, used by the agent)
   - Concatenated `questionsGrounded` / `rubricsGrounded` (preserved for report generation, which still walks the full transcript)

The session ends up with both shapes — the new one drives the agent, the flat one feeds `groq-feedback.ts` unchanged.

## 6. Agent code

### 6.1 `agent.py`

```python
class InterviewerBase(Agent):
    def __init__(self, *, instructions: str, index: Any, session_id: str, persona: Persona):
        super().__init__(
            instructions=instructions,
            tts=elevenlabs.TTS(
                voice_id=persona.voice_id,
                voice_settings=elevenlabs.VoiceSettings(
                    stability=persona.voice_stability,
                    similarity_boost=persona.voice_similarity_boost,
                    style=persona.voice_style,
                    speed=persona.voice_speed,
                    use_speaker_boost=persona.voice_use_speaker_boost,
                ),
            ),
        )
        self._index = index
        self._session_id = session_id
        self._persona = persona

    @function_tool
    async def lookup_cv_jd(self, query: str) -> str: ...  # unchanged

    @function_tool
    async def verify_cv_claim(self, claim: str) -> str: ...  # unchanged


class BehavioralInterviewer(InterviewerBase):
    @function_tool
    async def transfer_to_technical(self) -> Agent:
        """Hand off to the technical interviewer when behavioral round is complete."""
        return TechnicalInterviewer(
            instructions=_render_for(TECHNICAL_PERSONA, ...),
            index=self._index,
            session_id=self._session_id,
            persona=TECHNICAL_PERSONA,
        )


class TechnicalInterviewer(InterviewerBase):
    @function_tool
    async def transfer_to_system_design(self) -> Agent:
        """Hand off to the system design interviewer."""
        return SystemDesignInterviewer(...)


class SystemDesignInterviewer(InterviewerBase):
    @function_tool
    async def end_interview(self):
        """End the panel — final round complete. Closes the agent session."""
        # session.close() — exact API call resolved at impl time
        ...
```

The `entrypoint` function constructs `BehavioralInterviewer` first, passes it to `session.start(agent=..., room=ctx.room)`. The session swaps Agents on `@function_tool` return.

Each subclass's instructions are rendered from its persona's `system_prompt_template` with its own bucket of grounded questions (from `SessionData.questionsByPersona[persona.id]`).

### 6.2 `session_data.py`

`SessionData` extends with:

```python
@dataclass(frozen=True)
class QuestionsByPersona:
    behavioral: list[str]
    technical: list[str]
    system_design: list[str]

@dataclass(frozen=True)
class SessionData:
    # ... existing fields
    questions_by_persona: QuestionsByPersona
```

`load_session_data` reads `questionsByPersona` from the session doc and constructs `QuestionsByPersona`. If the field is missing, raises a clear error ("Session was created before multi-agent panel — start a new practice"). This is the migration path for old sessions: they error out cleanly rather than silently breaking.

### 6.3 Turn count safety ceiling

In `agent.py#entrypoint`, before `session.start`, wire an event listener that counts turns and calls `session.close()` if total exceeds 30.

### 6.4 `pipeline.build_session()` change

Remove `tts=elevenlabs.TTS(...)` from the session constructor. The session no longer carries a default TTS; the active Agent provides it. Update `_VOICE_SETTINGS` removal note.

## 7. Frontend changes

### 7.1 Transcript persona badges

`components/hr/ReportView.tsx` renders each transcript turn currently as user or assistant. The component takes `transcript: Array<{role, content, index}>`. Extend the prop to optionally include `metadata: { personaId?: string }`, and render a small badge next to the role label:

```
[Behavioral] AI · Tell me about a time you faced X...
[—]          You · Sure, at Razorpay...
[Technical]  AI · Walk me through the data structure...
```

`practice/[sessionId]/report/page.tsx` and `(hr)/reports/[sessionId]/page.tsx` both pull turn data from Firestore — they extend the mapping to include `metadata` from the turn doc.

### 7.2 Stale-session handling

`practice/[sessionId]/page.tsx` (status router) reads the session. If `inviteToken === "practice"` AND `questionsByPersona` is missing (legacy session pre-multi-agent), show a one-time toast "This practice session is from a previous version; please start a new one" and redirect to `/practice`. Avoids confusing 500 errors from the Python agent failing to load.

## 8. Existing-code changes summary

| File | Change |
|---|---|
| `types/index.d.ts` | Add `Session.questionsByPersona?`, `Session.rubricsByPersona?` |
| `constants/index.ts` | Add `partitionedTemplateSchema`, `partitionedGroundingSchema` zod schemas |
| `lib/llm/groq-template.ts` | Add `generatePartitionedQuestions()` |
| `lib/llm/groq-grounding.ts` | Add `regroundPartitionedQuestions()` |
| `lib/actions/practice.action.ts` | Rewire `createPracticeSession` to use partitioned generation, write both shapes |
| `livekit-agent/src/interview_agent/persona.py` | Extend `Persona` dataclass; add 3 persona constants |
| `livekit-agent/src/interview_agent/agent.py` | Replace `GeneralInterviewer` with `InterviewerBase` + 3 subclasses |
| `livekit-agent/src/interview_agent/session_data.py` | Add `QuestionsByPersona`, extend `SessionData`, fail-fast on missing field |
| `livekit-agent/src/interview_agent/pipeline.py` | Drop session-level TTS; agents own it |
| `components/hr/ReportView.tsx` | Render persona badges on transcript turns |
| `app/(practice)/practice/[sessionId]/page.tsx` | Legacy-session graceful fallback |
| `app/(practice)/practice/[sessionId]/report/page.tsx` | Pass turn metadata through to ReportView |
| `app/(hr)/reports/[sessionId]/page.tsx` | Same |

## 9. Testing

- Unit: `generatePartitionedQuestions` and `regroundPartitionedQuestions` happy path via Groq json_object mode (manual smoke; the codebase has no mocked Groq tests).
- Python unit: `test_persona.py` extended to assert all 3 persona constants exist with correct `next_persona_id` and voice_ids; `test_session_data.py` extended for the new `questions_by_persona` field; `test_agent.py` (existing test_agent stub) — verify the Agent subclasses construct and inherit `lookup_cv_jd` + `verify_cv_claim`.
- Manual smoke: start a fresh practice; verify (a) Sarah voice first, (b) voice swaps audibly at hand-off, (c) third voice for system design, (d) end_interview triggers report, (e) transcript view shows persona badges per turn.

## 10. Risks

- **Prompt-driven hand-off may not transfer cleanly.** Some LLMs over-stay in a round despite the rule. Mitigation: the 8-turn nudge in `rules`, plus the 30-turn hard ceiling. If after smoke the agent reliably overshoots, fall back to a per-agent turn counter and force-transfer in code.
- **Voice availability.** All three voice IDs are premade ElevenLabs voices and should always be available, but ElevenLabs occasionally moves voices. If a voice ID 404s at TTS-construction time the worker fails fast on dispatch (good — we want loud failure, not silent fallback). Recovery: swap voice IDs in the persona constants.
- **Stale practice sessions in Firestore.** Existing practice sessions from the pre-multi-agent era will fail to load. Mitigation: the status-router fallback in §7.2. We're not running a real migration because practice data is throwaway by definition.
