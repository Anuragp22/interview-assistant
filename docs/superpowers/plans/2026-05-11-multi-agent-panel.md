# Multi-Agent Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace `GeneralInterviewer` with a 3-agent panel (Behavioral → Technical → System Design) that hands off via LiveKit Agents 1.5's native pattern, each with its own ElevenLabs voice.

**Architecture:** New `InterviewerBase(Agent)` carries shared tools; three subclasses each have their own `transfer_to_<next>` `@function_tool`. Question generation partitions into 3 buckets per phase. Session schema gains `questionsByPersona` / `rubricsByPersona`. Report stays 5-category; transcript view gains a persona badge per turn.

**Tech Stack:** Same as v0.1 (Groq, LiveKit Agents 1.5, ElevenLabs, fastembed, Firebase) — no new dependencies.

---

## File structure

### New / extended

| Path | Change |
|---|---|
| `types/index.d.ts` | Add `Session.questionsByPersona?`, `Session.rubricsByPersona?` |
| `constants/index.ts` | Add `partitionedTemplateSchema`, `partitionedGroundingSchema` |
| `lib/llm/groq-template.ts` | Add `generatePartitionedQuestions()` |
| `lib/llm/groq-grounding.ts` | Add `regroundPartitionedQuestions()` |
| `lib/actions/practice.action.ts` | `createPracticeSession` rewired |
| `livekit-agent/src/interview_agent/persona.py` | Extend `Persona`, add 3 persona constants |
| `livekit-agent/src/interview_agent/agent.py` | Replace `GeneralInterviewer` with `InterviewerBase` + 3 subclasses |
| `livekit-agent/src/interview_agent/session_data.py` | Add `QuestionsByPersona`, extend `SessionData` |
| `livekit-agent/src/interview_agent/pipeline.py` | Drop session-level TTS |
| `livekit-agent/tests/test_persona.py` | Cover all 3 personas |
| `livekit-agent/tests/test_session_data.py` | Cover new field |
| `components/hr/ReportView.tsx` | Persona badges on transcript turns |
| `app/(practice)/practice/[sessionId]/page.tsx` | Stale-session fallback |
| `app/(practice)/practice/[sessionId]/report/page.tsx` | Pass turn metadata through |
| `app/(hr)/reports/[sessionId]/page.tsx` | Same |

---

## Tasks

### Task 1: Extend Session type with partitioned fields

**Files:** Modify `types/index.d.ts`

- [ ] **Step 1: Add `questionsByPersona` and `rubricsByPersona` to Session**

```ts
interface Session {
  id: string;
  templateId: string;
  inviteToken: string;
  candidateUid: string;
  hrUid?: string;
  cvStorageRef?: string;
  cvExtractedText?: string;
  questionsGrounded?: string[];
  rubricsGrounded?: RubricGrounded[];
  // Multi-agent panel: questions/rubrics split per persona.
  // When present, the agent reads these instead of the flat versions.
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
  status:
    | "awaiting-cv"
    | "awaiting-call"
    | "in-call"
    | "completed"
    | "abandoned";
  livekitRoomName: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npx tsc --noEmit
git add types/index.d.ts
git commit -m "feat(types): partition Session questions/rubrics by persona (3-agent panel)"
git push origin master
```

---

### Task 2: Zod schemas for partitioned generation

**Files:** Modify `constants/index.ts`

- [ ] **Step 1: Append schemas**

Find the existing `templateGenerationSchema` and `groundingSchema` near the bottom of `constants/index.ts`. Append:

```ts
// One bucket of (questions + rubrics) used by the partitioned schemas.
const partitionedBucketSchema = z.object({
  questions: z.array(z.string()).min(2).max(5),
  rubrics: z.array(rubricBaseSchema).min(2).max(5),
});

export const partitionedTemplateSchema = z.object({
  behavioral: partitionedBucketSchema,
  technical: partitionedBucketSchema,
  systemDesign: partitionedBucketSchema,
});

const partitionedGroundedBucketSchema = z.object({
  questionsGrounded: z.array(z.string()).min(2).max(5),
  rubricsGrounded: z.array(rubricGroundedSchema).min(2).max(5),
});

export const partitionedGroundingSchema = z.object({
  behavioral: partitionedGroundedBucketSchema,
  technical: partitionedGroundedBucketSchema,
  systemDesign: partitionedGroundedBucketSchema,
});
```

- [ ] **Step 2: Typecheck + commit**

```bash
npx tsc --noEmit
git add constants/index.ts
git commit -m "feat(constants): zod schemas for partitioned 3-persona generation"
git push origin master
```

---

### Task 3: `generatePartitionedQuestions` (Phase 1)

**Files:** Modify `lib/llm/groq-template.ts`

- [ ] **Step 1: Append the new function**

At the bottom of `lib/llm/groq-template.ts` (keep the existing `generateQuestionsAndRubrics` unchanged):

```ts
import { partitionedTemplateSchema } from "@/constants";

export async function generatePartitionedQuestions(input: {
  role: string;
  level: "Junior" | "Mid" | "Senior" | "Staff";
  jobDescription: string;
}): Promise<{
  behavioral: { questions: string[]; rubrics: RubricBase[] };
  technical: { questions: string[]; rubrics: RubricBase[] };
  systemDesign: { questions: string[]; rubrics: RubricBase[] };
}> {
  const { object } = await generateObject({
    model: groq(GROQ_MODEL),
    providerOptions: { groq: { structuredOutputs: false } },
    schema: partitionedTemplateSchema,
    system:
      "You are an expert technical interviewer designing a 3-round panel.",
    prompt: `
Design an interview panel for a ${input.role} (${input.level}) role. The
panel has THREE rounds, each conducted by a different interviewer:

1. Behavioral — STAR-method probes (situations, tasks, actions, results).
2. Technical — concrete implementation depth (data structures, time
   complexity, language-level decisions).
3. System Design — distributed-systems design, constraints, trade-offs,
   bottlenecks.

Generate 3 questions per round (9 total), each with a base rubric.

Role: ${input.role} (${input.level})
Job description:
${input.jobDescription}

Respond with ONE JSON object matching this exact shape:

{
  "behavioral":   { "questions": [...3 strings...], "rubrics": [...3 rubric objects...] },
  "technical":    { "questions": [...3 strings...], "rubrics": [...3 rubric objects...] },
  "systemDesign": { "questions": [...3 strings...], "rubrics": [...3 rubric objects...] }
}

Each rubric object has shape:
{
  "expectedConcepts":  ["..."],     // concepts a strong answer covers
  "expectedSpecifics": ["..."],     // role-specific tech / patterns / metrics
  "depth":             "foundational" | "intermediate" | "advanced",
  "priority":          1 | 2 | 3    // 1 = must-have, 3 = nice-to-have
}

Critical rules:
- Each bucket has EXACTLY 3 questions and 3 rubrics, in matching order.
- Behavioral questions reference past experience, NOT theoretical scenarios.
- Technical questions probe specific tech/patterns; avoid "tell me about X" generics.
- System Design questions are open-ended (no single right answer).
- Output JSON only — no preamble, no code fences.
    `,
  });

  return {
    behavioral: object.behavioral as { questions: string[]; rubrics: RubricBase[] },
    technical: object.technical as { questions: string[]; rubrics: RubricBase[] },
    systemDesign: object.systemDesign as { questions: string[]; rubrics: RubricBase[] },
  };
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npx tsc --noEmit
git add lib/llm/groq-template.ts
git commit -m "feat(llm): generatePartitionedQuestions for 3-persona panel (Phase 1)"
git push origin master
```

---

### Task 4: `regroundPartitionedQuestions` (Phase 2)

**Files:** Modify `lib/llm/groq-grounding.ts`

- [ ] **Step 1: Append the new function**

At the bottom of `lib/llm/groq-grounding.ts`:

```ts
import { partitionedGroundingSchema } from "@/constants";

export async function regroundPartitionedQuestions(input: {
  questionsByPersona: {
    behavioral: string[];
    technical: string[];
    systemDesign: string[];
  };
  rubricsByPersona: {
    behavioral: RubricBase[];
    technical: RubricBase[];
    systemDesign: RubricBase[];
  };
  jobDescription: string;
  cvText: string;
}): Promise<{
  behavioral: { questionsGrounded: string[]; rubricsGrounded: RubricGrounded[] };
  technical: { questionsGrounded: string[]; rubricsGrounded: RubricGrounded[] };
  systemDesign: { questionsGrounded: string[]; rubricsGrounded: RubricGrounded[] };
}> {
  const renderBucket = (
    name: string,
    qs: string[],
    rs: RubricBase[],
  ) =>
    `## ${name}\n` +
    qs
      .map(
        (q, i) =>
          `Q${i + 1}: ${q}\n` +
          `  expectedConcepts: ${rs[i].expectedConcepts.join(", ")}\n` +
          `  expectedSpecifics: ${rs[i].expectedSpecifics.join(", ")}`,
      )
      .join("\n");

  const block =
    renderBucket("Behavioral", input.questionsByPersona.behavioral, input.rubricsByPersona.behavioral) +
    "\n\n" +
    renderBucket("Technical", input.questionsByPersona.technical, input.rubricsByPersona.technical) +
    "\n\n" +
    renderBucket("SystemDesign", input.questionsByPersona.systemDesign, input.rubricsByPersona.systemDesign);

  const { object } = await generateObject({
    model: groq(GROQ_MODEL),
    providerOptions: { groq: { structuredOutputs: false } },
    schema: partitionedGroundingSchema,
    system:
      "You re-ground base interview questions in the candidate's CV. Output a single JSON object matching the schema.",
    prompt: `
Re-ground the base questions below in the candidate's CV. For each
question, rewrite it to reference specific projects, companies, or
technologies from the CV when relevant. For each rubric, add a
"cvReference" field pointing to the specific CV detail the question
targets.

Job description:
${input.jobDescription}

Candidate CV:
${input.cvText}

Base questions (3 per round):
${block}

Respond with ONE JSON object:

{
  "behavioral":   { "questionsGrounded": [...3 strings...], "rubricsGrounded": [...3 rubric+cvReference objects...] },
  "technical":    { "questionsGrounded": [...], "rubricsGrounded": [...] },
  "systemDesign": { "questionsGrounded": [...], "rubricsGrounded": [...] }
}

Each grounded rubric extends the base rubric with cvReference:
{
  "expectedConcepts":  [...],
  "expectedSpecifics": [...],
  "depth":             "...",
  "priority":          ...,
  "cvReference":       "..."   // a phrase from the CV that anchors this question
}

Critical rules:
- Preserve question count: 3 per bucket, in original order.
- Reference specific CV details — companies, projects, tech — when natural.
- If a question doesn't map to anything in the CV, keep it close to the base version (don't fabricate CV facts).
- Output JSON only.
    `,
  });

  return {
    behavioral: object.behavioral as {
      questionsGrounded: string[];
      rubricsGrounded: RubricGrounded[];
    },
    technical: object.technical as {
      questionsGrounded: string[];
      rubricsGrounded: RubricGrounded[];
    },
    systemDesign: object.systemDesign as {
      questionsGrounded: string[];
      rubricsGrounded: RubricGrounded[];
    },
  };
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npx tsc --noEmit
git add lib/llm/groq-grounding.ts
git commit -m "feat(llm): regroundPartitionedQuestions for 3-persona panel (Phase 2)"
git push origin master
```

---

### Task 5: Rewire `createPracticeSession`

**Files:** Modify `lib/actions/practice.action.ts`

- [ ] **Step 1: Swap imports**

At the top of the file, replace:

```ts
import { generateQuestionsAndRubrics } from "@/lib/llm/groq-template";
import { regroundQuestions } from "@/lib/llm/groq-grounding";
```

with:

```ts
import { generatePartitionedQuestions } from "@/lib/llm/groq-template";
import { regroundPartitionedQuestions } from "@/lib/llm/groq-grounding";
```

- [ ] **Step 2: Rewrite the Phase 1 + Phase 2 + session-write steps**

Inside `createPracticeSession`, replace the existing steps 2 (Phase 1), 3 (template doc), 4 (Phase 2), and 5 (session doc) with:

```ts
    // 2. Phase 1 — partitioned questions/rubrics across 3 personas.
    const phase1 = await generatePartitionedQuestions({
      role: input.role,
      level: input.level,
      jobDescription: input.jobDescription,
    });

    // Flat concatenation for the template doc and the report generator,
    // which still walks the full transcript holistically.
    const flatQuestionsBase = [
      ...phase1.behavioral.questions,
      ...phase1.technical.questions,
      ...phase1.systemDesign.questions,
    ];
    const flatRubricsBase = [
      ...phase1.behavioral.rubrics,
      ...phase1.technical.rubrics,
      ...phase1.systemDesign.rubrics,
    ];

    // 3. Create the template doc (hrUid = owner).
    const tref = db.collection("templates").doc();
    const now = new Date().toISOString();
    await tref.set({
      id: tref.id,
      hrUid: uid,
      title: `Practice: ${input.role}`,
      role: input.role,
      level: input.level,
      jobDescription: input.jobDescription,
      questionsBase: flatQuestionsBase,
      rubricsBase: flatRubricsBase,
      status: "draft" as const,
      createdAt: now,
      updatedAt: now,
    });

    // 4. Phase 2 — partitioned reground against the CV.
    const phase2 = await regroundPartitionedQuestions({
      questionsByPersona: {
        behavioral: phase1.behavioral.questions,
        technical: phase1.technical.questions,
        systemDesign: phase1.systemDesign.questions,
      },
      rubricsByPersona: {
        behavioral: phase1.behavioral.rubrics,
        technical: phase1.technical.rubrics,
        systemDesign: phase1.systemDesign.rubrics,
      },
      jobDescription: input.jobDescription,
      cvText: cv.extractedText,
    });

    const flatQuestionsGrounded = [
      ...phase2.behavioral.questionsGrounded,
      ...phase2.technical.questionsGrounded,
      ...phase2.systemDesign.questionsGrounded,
    ];
    const flatRubricsGrounded = [
      ...phase2.behavioral.rubricsGrounded,
      ...phase2.technical.rubricsGrounded,
      ...phase2.systemDesign.rubricsGrounded,
    ];

    // 5. Create the session doc with BOTH partitioned and flat shapes.
    //    The Python agent reads questionsByPersona; the report generator
    //    reads the flat versions.
    const sref = db.collection("sessions").doc();
    await sref.set({
      id: sref.id,
      templateId: tref.id,
      inviteToken: "practice",
      candidateUid: uid,
      hrUid: uid,
      cvStorageRef: cv.storageRef,
      cvExtractedText: cv.extractedText,
      questionsGrounded: flatQuestionsGrounded,
      rubricsGrounded: flatRubricsGrounded,
      questionsByPersona: {
        behavioral: phase2.behavioral.questionsGrounded,
        technical: phase2.technical.questionsGrounded,
        systemDesign: phase2.systemDesign.questionsGrounded,
      },
      rubricsByPersona: {
        behavioral: phase2.behavioral.rubricsGrounded,
        technical: phase2.technical.rubricsGrounded,
        systemDesign: phase2.systemDesign.rubricsGrounded,
      },
      status: "awaiting-call" as const,
      livekitRoomName: `session-${sref.id}`,
      createdAt: new Date().toISOString(),
    });
```

- [ ] **Step 3: Typecheck + commit**

```bash
npx tsc --noEmit
git add lib/actions/practice.action.ts
git commit -m "feat(practice): createPracticeSession writes partitioned questions for panel"
git push origin master
```

---

### Task 6: Extend `Persona` dataclass + add 3 persona constants

**Files:** Modify `livekit-agent/src/interview_agent/persona.py`

- [ ] **Step 1: Rewrite the file**

Replace the entire file content:

```python
"""Persona definitions for the multi-agent interview panel.

Three personas, each with its own voice + system-prompt rules. The
agent.py module exposes one Agent subclass per persona; hand-off
between them uses LiveKit Agents 1.5's native @function_tool return-
Agent pattern.
"""

from __future__ import annotations

from dataclasses import dataclass


COMMON_RULES = """\
- Be transparent: this is an AI-conducted screening conversation. If asked, confirm plainly.
- Score on substance only. NEVER penalise accent, dialect, or speech patterns.
- Stay grounded in BOTH the job description and the candidate's actual CV. When the agenda
  question references something specific from the candidate's background (a project, a
  company, a tech), ask about THAT, not a generic alternative.
- When you need a concrete fact about the candidate's CV or the JD that isn't already
  obvious from the agenda question, call the `lookup_cv_jd` tool with a short query.
- Whenever the candidate mentions a specific project, employer, technology, tenure, or
  numeric outcome that you cannot verify from the agenda question alone, call the
  `verify_cv_claim` tool with the claim verbatim BEFORE asking follow-up questions
  that treat the claim as fact. If the verdict comes back "unsupported", do not
  challenge the candidate aggressively, but ask them to substantiate it
  ("Can you walk me through where you did that?") rather than accepting at face value.
"""


HANDOFF_RULE = """\
- You are part of a 3-interviewer panel. After ~3-6 substantive turns of dialogue
  with the candidate, call `transfer_to_<next>` (or `end_interview` for the last
  agent) to move the panel forward. After 8 turns you MUST transfer regardless of
  signal. Do NOT announce the hand-off as a separate utterance — the next
  interviewer will introduce themselves naturally when activated.
"""


GENERAL_TEMPLATE = """\
You are {name}, a {expertise_area}.

You are interviewing {candidate_name} for {role} ({level}).

Your interview agenda for this round — these questions are already grounded in
the candidate's CV and the job description. Reference specifics naturally; e.g.
when a question mentions "Razorpay", you can ask about it directly without
disclaiming.

{questions_block}

Tools available:
- lookup_cv_jd(query): retrieve concrete details from the candidate's CV or JD.
- verify_cv_claim(claim): check whether a candidate-stated claim is supported.

Conduct rules:
{rules}
"""


@dataclass(frozen=True)
class Persona:
    """Per-persona config: identity + voice + prompt rules + next-in-panel."""

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
    next_persona_id: str | None  # for hand-off; None on the last persona


_BEHAVIORAL_RULES = (
    COMMON_RULES
    + "\n"
    + """\
- Use the STAR framework: probe for Situation, Task, Action, Result. If a candidate
  stops at the surface, ask one follow-up to get to the action or result.
- Don't ask theoretical "what if" questions — anchor in real past experience from the
  candidate's CV.
"""
    + HANDOFF_RULE
)


_TECHNICAL_RULES = (
    COMMON_RULES
    + "\n"
    + """\
- Push on concrete implementation details: data structures used, time complexity
  reasoning, code-level trade-offs.
- Ask "why" more than "what". If the candidate gives a high-level answer, ask them to
  walk through a specific decision they made.
"""
    + HANDOFF_RULE
)


_SYSTEM_DESIGN_RULES = (
    COMMON_RULES
    + "\n"
    + """\
- Begin with constraints and assumptions before the candidate draws anything. Force
  them to articulate at least one bottleneck and one trade-off.
- Probe scalability + failure modes once the happy path is sketched.
"""
    + HANDOFF_RULE
)


BEHAVIORAL_PERSONA = Persona(
    id="behavioral",
    name="Sarah",
    expertise_area="behavioral interviewer specialising in STAR-framework probes",
    voice_id="EXAVITQu4vr4xnSDxMaL",
    voice_stability=0.4,
    voice_similarity_boost=0.8,
    voice_speed=0.9,
    voice_style=0.5,
    voice_use_speaker_boost=True,
    system_prompt_template=GENERAL_TEMPLATE,
    rules=_BEHAVIORAL_RULES,
    next_persona_id="technical",
)


TECHNICAL_PERSONA = Persona(
    id="technical",
    name="Adam",
    expertise_area="senior technical interviewer who probes implementation depth",
    voice_id="pNInz6obpgDQGcFmaJgB",
    voice_stability=0.5,
    voice_similarity_boost=0.85,
    voice_speed=1.0,
    voice_style=0.3,
    voice_use_speaker_boost=True,
    system_prompt_template=GENERAL_TEMPLATE,
    rules=_TECHNICAL_RULES,
    next_persona_id="system-design",
)


SYSTEM_DESIGN_PERSONA = Persona(
    id="system-design",
    name="Bella",
    expertise_area="senior systems engineer focused on distributed-systems design",
    voice_id="oWAxZDx7w5VEj9dCyTzz",
    voice_stability=0.5,
    voice_similarity_boost=0.8,
    voice_speed=0.85,
    voice_style=0.4,
    voice_use_speaker_boost=True,
    system_prompt_template=GENERAL_TEMPLATE,
    rules=_SYSTEM_DESIGN_RULES,
    next_persona_id=None,
)


# Convenience lookup so other modules don't import the constants directly.
PERSONA_BY_ID: dict[str, Persona] = {
    p.id: p for p in (BEHAVIORAL_PERSONA, TECHNICAL_PERSONA, SYSTEM_DESIGN_PERSONA)
}


def render_system_prompt(
    persona: Persona,
    candidate_name: str,
    role: str,
    level: str,
    questions_grounded: list[str],
) -> str:
    """Render this persona's template with the round's questions."""
    questions_block = "\n".join(
        f"{i + 1}. {q}" for i, q in enumerate(questions_grounded)
    )
    return persona.system_prompt_template.format(
        name=persona.name,
        expertise_area=persona.expertise_area,
        candidate_name=candidate_name,
        role=role,
        level=level,
        questions_block=questions_block,
        rules=persona.rules,
    )
```

- [ ] **Step 2: Commit**

```bash
git add livekit-agent/src/interview_agent/persona.py
git commit -m "feat(agent): 3 personas (Behavioral/Technical/SystemDesign) with own voice + rules"
git push origin master
```

---

### Task 7: Extend SessionData with `questions_by_persona`

**Files:** Modify `livekit-agent/src/interview_agent/session_data.py`

- [ ] **Step 1: Add `QuestionsByPersona` and extend SessionData**

Replace the file with:

```python
"""Loads per-session interview data from Firestore."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any


logger = logging.getLogger("interview-agent.session_data")


@dataclass(frozen=True)
class QuestionsByPersona:
    """Questions partitioned across the 3-agent panel."""

    behavioral: list[str]
    technical: list[str]
    system_design: list[str]


@dataclass(frozen=True)
class SessionData:
    """All the per-session inputs the agent needs to start a call."""

    session_id: str
    candidate_uid: str
    candidate_name: str
    role: str
    level: str
    job_description: str
    cv_extracted_text: str
    questions_by_persona: QuestionsByPersona


SESSION_ROOM_PREFIX = "session-"


def parse_session_id_from_room(room_name: str) -> str | None:
    """Extract the session id from a LiveKit room name."""
    if not room_name.startswith(SESSION_ROOM_PREFIX):
        return None
    return room_name[len(SESSION_ROOM_PREFIX):]


def load_session_data(db: Any, session_id: str) -> SessionData:
    """Load a session + the parent template + the candidate user doc.

    Raises if any required field is missing — fail fast at dispatch
    rather than halfway through a call.
    """
    session_doc = db.collection("sessions").document(session_id).get()
    if not session_doc.exists:
        raise RuntimeError(f"Session {session_id} not found")
    session = session_doc.to_dict()

    if session.get("status") not in ("awaiting-call", "in-call", "reconnecting"):
        raise RuntimeError(
            f"Session {session_id} is not in a callable state: {session.get('status')}"
        )

    cv_text = session.get("cvExtractedText")
    if not cv_text:
        raise RuntimeError(f"Session {session_id} has no cvExtractedText")

    qbp = session.get("questionsByPersona")
    if not qbp:
        raise RuntimeError(
            f"Session {session_id} has no questionsByPersona — created before "
            "multi-agent panel rollout, ask the user to start a new practice."
        )
    for key in ("behavioral", "technical", "systemDesign"):
        if not qbp.get(key):
            raise RuntimeError(
                f"Session {session_id} questionsByPersona missing bucket: {key}"
            )

    template_doc = (
        db.collection("templates").document(session["templateId"]).get()
    )
    if not template_doc.exists:
        raise RuntimeError(
            f"Template {session['templateId']} not found for session {session_id}"
        )
    template = template_doc.to_dict()

    user_doc = db.collection("users").document(session["candidateUid"]).get()
    candidate_name = "Candidate"
    if user_doc.exists:
        candidate_name = user_doc.to_dict().get("displayName", "Candidate")

    return SessionData(
        session_id=session_id,
        candidate_uid=session["candidateUid"],
        candidate_name=candidate_name,
        role=template["role"],
        level=template["level"],
        job_description=template["jobDescription"],
        cv_extracted_text=cv_text,
        questions_by_persona=QuestionsByPersona(
            behavioral=list(qbp["behavioral"]),
            technical=list(qbp["technical"]),
            system_design=list(qbp["systemDesign"]),
        ),
    )
```

- [ ] **Step 2: Commit**

```bash
git add livekit-agent/src/interview_agent/session_data.py
git commit -m "feat(agent): SessionData carries questionsByPersona; fail-fast on legacy sessions"
git push origin master
```

---

### Task 8: Rewrite `agent.py` with 3 Agent subclasses

**Files:** Modify `livekit-agent/src/interview_agent/agent.py`, `livekit-agent/src/interview_agent/pipeline.py`

- [ ] **Step 1: Drop session-level TTS in pipeline.py**

In `livekit-agent/src/interview_agent/pipeline.py`, remove the TTS construction from `build_session`:

```python
def build_session(*, vad: silero.VAD | None = None) -> AgentSession:
    return AgentSession(
        vad=vad if vad is not None else silero.VAD.load(),
        stt=deepgram.STT(model="nova-2", language="en-US"),
        llm=_build_groq_llm(),
        # tts intentionally omitted — each Agent subclass provides its own
        # via persona-specific voice_settings.
    )
```

Also delete the `_VOICE_SETTINGS` constant block at the top of the file and the `from livekit.plugins import ... elevenlabs ...` import (still needed if any test does provider isinstance checks — keep the import line but stop using elevenlabs in build_session).

- [ ] **Step 2: Rewrite agent.py's Agent subclasses**

In `livekit-agent/src/interview_agent/agent.py`, find the `GeneralInterviewer` class (lines ~118-132). Replace it AND the entrypoint's Agent construction with:

```python
from livekit.plugins import elevenlabs
from interview_agent.persona import (
    BEHAVIORAL_PERSONA,
    TECHNICAL_PERSONA,
    SYSTEM_DESIGN_PERSONA,
    Persona,
    render_system_prompt,
)


class InterviewerBase(Agent):
    """Shared base for the 3-agent panel. Owns the common tools
    (lookup_cv_jd, verify_cv_claim) and the per-persona TTS override."""

    def __init__(
        self,
        *,
        instructions: str,
        index: Any,
        session_id: str,
        persona: Persona,
    ) -> None:
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
    async def lookup_cv_jd(self, query: str) -> str:
        """Look up specifics from the candidate's CV or the job description.
        Use when you need a concrete fact (project name, tech, dates,
        specific JD requirement) before asking a question or follow-up.
        Returns the most relevant chunks from the indexed CV+JD."""
        return await query_index(self._index, query, top_k=3)

    @function_tool
    async def verify_cv_claim(self, claim: str) -> str:
        """Verify whether a candidate's stated claim is supported by their
        CV or the job description. Call this whenever the candidate
        mentions a specific project, employer, technology, tenure, or
        numeric outcome that isn't already in the agenda question.

        Pass the claim VERBATIM (or close to it). Returns one of three
        verdicts (supported / ambiguous / unsupported) with similarity
        score and supporting evidence."""
        result = await verify_claim(self._index, claim)
        return result.for_llm()


def _make_next_agent(
    persona: Persona,
    *,
    index: Any,
    session_id: str,
    candidate_name: str,
    role: str,
    level: str,
    questions_grounded: list[str],
):
    """Build the next Agent subclass instance for a given persona.

    Centralised here so the transfer_to_* tools don't repeat the
    render_system_prompt call. The mapping persona.id -> subclass is
    explicit; if a new persona is added (sub-project F), add a branch.
    """
    instructions = render_system_prompt(
        persona=persona,
        candidate_name=candidate_name,
        role=role,
        level=level,
        questions_grounded=questions_grounded,
    )
    if persona.id == "behavioral":
        return BehavioralInterviewer(
            instructions=instructions,
            index=index,
            session_id=session_id,
            persona=persona,
            candidate_name=candidate_name,
            role=role,
            level=level,
        )
    if persona.id == "technical":
        return TechnicalInterviewer(
            instructions=instructions,
            index=index,
            session_id=session_id,
            persona=persona,
            candidate_name=candidate_name,
            role=role,
            level=level,
        )
    if persona.id == "system-design":
        return SystemDesignInterviewer(
            instructions=instructions,
            index=index,
            session_id=session_id,
            persona=persona,
            candidate_name=candidate_name,
            role=role,
            level=level,
        )
    raise RuntimeError(f"Unknown persona: {persona.id}")


class BehavioralInterviewer(InterviewerBase):
    """Round 1 — STAR-method behavioral interviewer (Sarah)."""

    def __init__(
        self, *, candidate_name: str, role: str, level: str, **kwargs: Any
    ) -> None:
        super().__init__(**kwargs)
        self._candidate_name = candidate_name
        self._role = role
        self._level = level

    @function_tool
    async def transfer_to_technical(self) -> Agent:
        """Hand off to the technical interviewer when the behavioral round
        has gathered enough signal (typically after 3-6 turns).
        After 8 turns you must transfer regardless."""
        # Note: questions_grounded for the next round is read by load_session_data
        # and passed in at construction. The framework swaps the active Agent.
        from interview_agent.session_data import (
            QuestionsByPersona,
        )
        # The next agent needs its own questions bucket. We can't load
        # SessionData again here (it's expensive), so we stash the buckets
        # on the entrypoint scope. For now, we re-fetch via the agent
        # context the entrypoint set up — see entrypoint code below.
        next_qs = _NEXT_QUESTIONS_BY_PERSONA.get("technical", [])
        return _make_next_agent(
            TECHNICAL_PERSONA,
            index=self._index,
            session_id=self._session_id,
            candidate_name=self._candidate_name,
            role=self._role,
            level=self._level,
            questions_grounded=next_qs,
        )


class TechnicalInterviewer(InterviewerBase):
    """Round 2 — implementation-depth technical interviewer (Adam)."""

    def __init__(
        self, *, candidate_name: str, role: str, level: str, **kwargs: Any
    ) -> None:
        super().__init__(**kwargs)
        self._candidate_name = candidate_name
        self._role = role
        self._level = level

    @function_tool
    async def transfer_to_system_design(self) -> Agent:
        """Hand off to the system design interviewer when the technical
        round is complete (typically 3-6 turns). After 8 turns you must
        transfer regardless."""
        next_qs = _NEXT_QUESTIONS_BY_PERSONA.get("system-design", [])
        return _make_next_agent(
            SYSTEM_DESIGN_PERSONA,
            index=self._index,
            session_id=self._session_id,
            candidate_name=self._candidate_name,
            role=self._role,
            level=self._level,
            questions_grounded=next_qs,
        )


class SystemDesignInterviewer(InterviewerBase):
    """Round 3 — system design interviewer (Bella). Last in the panel."""

    def __init__(
        self, *, candidate_name: str, role: str, level: str, **kwargs: Any
    ) -> None:
        super().__init__(**kwargs)
        self._candidate_name = candidate_name
        self._role = role
        self._level = level

    @function_tool
    async def end_interview(self) -> None:
        """End the interview after the system design round.
        Call this when you have enough signal or after 8 turns. The
        candidate's recording wraps up and report generation begins."""
        # Closing the session is handled by AgentSession's own machinery
        # when the LLM returns None from a tool — but explicit is better:
        # signal the entrypoint via a session-scoped flag.
        _END_INTERVIEW_FLAG.set()


# Module-level state used by the transfer tools to pass per-round questions
# without re-loading SessionData on every hand-off. Populated by the
# entrypoint once at room dispatch. Single-worker-per-room semantics make
# this safe (each session has its own worker process).
_NEXT_QUESTIONS_BY_PERSONA: dict[str, list[str]] = {}
import asyncio as _asyncio_for_flag
_END_INTERVIEW_FLAG = _asyncio_for_flag.Event()
```

- [ ] **Step 3: Rewrite the `entrypoint` to start with BehavioralInterviewer**

In the same `agent.py`, find the existing `entrypoint` function (around line 135). Replace the Agent-construction block (between `# 4. Render persona prompt and instantiate Agent.` and `# 5. Wire turn persistence with bias-audit metadata.`) with:

```python
    # 4. Stash per-round questions on the module-level dict so transfer
    #    tools can pick them up without re-loading SessionData.
    _NEXT_QUESTIONS_BY_PERSONA.clear()
    _NEXT_QUESTIONS_BY_PERSONA["behavioral"] = list(
        session_data.questions_by_persona.behavioral
    )
    _NEXT_QUESTIONS_BY_PERSONA["technical"] = list(
        session_data.questions_by_persona.technical
    )
    _NEXT_QUESTIONS_BY_PERSONA["system-design"] = list(
        session_data.questions_by_persona.system_design
    )
    _END_INTERVIEW_FLAG.clear()

    # 5. Construct the first Agent (Behavioral round).
    first_instructions = render_system_prompt(
        persona=BEHAVIORAL_PERSONA,
        candidate_name=session_data.candidate_name,
        role=session_data.role,
        level=session_data.level,
        questions_grounded=session_data.questions_by_persona.behavioral,
    )
    agent = BehavioralInterviewer(
        instructions=first_instructions,
        index=index,
        session_id=session_id,
        persona=BEHAVIORAL_PERSONA,
        candidate_name=session_data.candidate_name,
        role=session_data.role,
        level=session_data.level,
    )
```

- [ ] **Step 4: Wire the end-interview flag to actually end the session**

In `entrypoint`, AFTER `await voice_session.start(agent=agent, room=ctx.room)`, add:

```python
    # Hard ceiling: end after 30 total turns OR when end_interview tool fires.
    # The turn count is already tracked by the existing _on_item handler;
    # we just check it after each turn alongside the explicit end flag.

    async def _watch_for_end():
        await _END_INTERVIEW_FLAG.wait()
        logger.info("end_interview tool called; closing session")
        await voice_session.aclose()

    asyncio.create_task(_watch_for_end())
```

Add `import asyncio` near the top of `agent.py` if not present.

In the existing `_on_item` handler (turn persistence), after `turns_repo.append_turn(turn)`, add:

```python
        # Safety net: hard-cap total turns to 30. The 8-turn-per-agent soft
        # cap lives in the persona rules; this catches LLM-misbehaviour
        # cases where the active agent simply won't transfer.
        if turn_index >= 30:
            logger.warning(
                "session %s hit 30-turn ceiling; ending", session_id
            )
            _END_INTERVIEW_FLAG.set()
```

Also update the turn metadata `personaId` to use the currently active persona. The active agent's `_persona.id` is the source of truth — read it via `voice_session.current_agent` if exposed, else default to whichever agent the worker started with. Simpler approach: hardcode-ish via the entrypoint local variable. For v1, use:

```python
        metadata={
            "personaId": getattr(
                getattr(voice_session, "_agent", None),
                "_persona",
                BEHAVIORAL_PERSONA,
            ).id,
            "modelId": "llama-3.3-70b-versatile",
        },
```

The fallback to `BEHAVIORAL_PERSONA` is for the first few turns before any hand-off; after a transfer the framework swaps in the new Agent so `_agent._persona` reflects the active one. (If `voice_session._agent` is not the actual public API for the active agent in livekit-agents 1.5, swap to the correct accessor — confirm by reading the AgentSession source or release notes.)

- [ ] **Step 5: Typecheck the Python side (no Python typecheck — use pyright via uv if present, else skip)**

Run the pytest suite — broken imports surface here:

```bash
cd livekit-agent && .venv/Scripts/python.exe -m pytest tests/test_persona.py tests/test_session_data.py -v
```

Expected: all pass (these tests have been updated in earlier tasks).

- [ ] **Step 6: Commit**

```bash
cd ..
git add livekit-agent/src/interview_agent/agent.py livekit-agent/src/interview_agent/pipeline.py
git commit -m "feat(agent): 3-Agent panel with native LiveKit hand-off + per-Agent TTS"
git push origin master
```

---

### Task 9: Update persona + session-data tests

**Files:** Modify `livekit-agent/tests/test_persona.py`, `livekit-agent/tests/test_session_data.py`

- [ ] **Step 1: Replace `test_persona.py`**

```python
"""Unit tests for the Persona module (3-agent panel)."""

from interview_agent.persona import (
    BEHAVIORAL_PERSONA,
    COMMON_RULES,
    PERSONA_BY_ID,
    SYSTEM_DESIGN_PERSONA,
    TECHNICAL_PERSONA,
    render_system_prompt,
)


def test_three_personas_exist_with_distinct_voices_and_chain():
    voice_ids = {
        BEHAVIORAL_PERSONA.voice_id,
        TECHNICAL_PERSONA.voice_id,
        SYSTEM_DESIGN_PERSONA.voice_id,
    }
    assert len(voice_ids) == 3, "all three personas must have distinct voices"

    assert BEHAVIORAL_PERSONA.next_persona_id == "technical"
    assert TECHNICAL_PERSONA.next_persona_id == "system-design"
    assert SYSTEM_DESIGN_PERSONA.next_persona_id is None


def test_persona_by_id_covers_all_three():
    assert set(PERSONA_BY_ID.keys()) == {"behavioral", "technical", "system-design"}


def test_rendered_prompt_carries_persona_specifics_and_handoff_rule():
    rendered = render_system_prompt(
        persona=BEHAVIORAL_PERSONA,
        candidate_name="Anurag",
        role="Senior Frontend Engineer",
        level="Senior",
        questions_grounded=[
            "Walk me through how the search filters at Razorpay scaled.",
            "How did your team handle CI/CD?",
        ],
    )
    assert "Sarah" in rendered  # persona name
    assert "Anurag" in rendered  # candidate name
    assert "Razorpay" in rendered  # grounded question
    assert "STAR" in rendered  # behavioral-specific rule
    assert "transfer_to_" in rendered  # hand-off rule
    assert "lookup_cv_jd" in rendered  # common tool
    assert "verify_cv_claim" in rendered  # common tool


def test_rendered_prompt_omits_raw_cv_or_jd():
    rendered = render_system_prompt(
        persona=BEHAVIORAL_PERSONA,
        candidate_name="Anurag",
        role="X",
        level="Mid",
        questions_grounded=["Q1"],
    )
    assert "{cv_text}" not in rendered
    assert "{job_description}" not in rendered


def test_technical_persona_rules_target_implementation_depth():
    assert "implementation" in TECHNICAL_PERSONA.rules.lower()


def test_system_design_persona_rules_target_constraints_and_tradeoffs():
    rules = SYSTEM_DESIGN_PERSONA.rules.lower()
    assert "constraint" in rules or "trade-off" in rules or "tradeoff" in rules


def test_common_rules_bias_clause_present_in_all_personas():
    for p in (BEHAVIORAL_PERSONA, TECHNICAL_PERSONA, SYSTEM_DESIGN_PERSONA):
        assert "accent" in p.rules.lower()  # bias rule
```

- [ ] **Step 2: Update `test_session_data.py` to use the new questions field**

Find the existing `_make_db` helper and the happy-path test. Update them to include `questionsByPersona` instead of (or alongside) `questionsGrounded`:

```python
def test_load_session_data_happy_path():
    db = _make_db(
        session_data={
            "templateId": "tpl1",
            "candidateUid": "u1",
            "status": "awaiting-call",
            "cvExtractedText": "CV text",
            "questionsByPersona": {
                "behavioral": ["Q-b1", "Q-b2"],
                "technical": ["Q-t1", "Q-t2"],
                "systemDesign": ["Q-sd1"],
            },
        },
        template_data={
            "role": "Senior Frontend",
            "level": "Senior",
            "jobDescription": "JD body",
        },
        user_data={"displayName": "Anurag"},
    )
    sd = load_session_data(db, "sess1")
    assert sd.session_id == "sess1"
    assert sd.candidate_uid == "u1"
    assert sd.candidate_name == "Anurag"
    assert sd.role == "Senior Frontend"
    assert sd.cv_extracted_text == "CV text"
    assert sd.questions_by_persona.behavioral == ["Q-b1", "Q-b2"]
    assert sd.questions_by_persona.technical == ["Q-t1", "Q-t2"]
    assert sd.questions_by_persona.system_design == ["Q-sd1"]


def test_load_session_data_raises_when_missing_questions_by_persona():
    """Sessions created before the multi-agent rollout must fail loud."""
    import pytest

    db = _make_db(
        session_data={
            "templateId": "tpl1",
            "candidateUid": "u1",
            "status": "awaiting-call",
            "cvExtractedText": "CV text",
            # no questionsByPersona
        },
        template_data={"role": "x", "level": "Mid", "jobDescription": "x"},
        user_data={"displayName": "x"},
    )
    with pytest.raises(RuntimeError, match="questionsByPersona"):
        load_session_data(db, "sess1")
```

Remove or rename the old `test_load_session_data_raises_when_missing_cv_text` style tests if they assert behavior of the flat `questionsGrounded` field — they're obsolete. (cv-text test stays — that rule didn't change.)

- [ ] **Step 3: Run python tests**

```bash
cd livekit-agent && .venv/Scripts/python.exe -m pytest -v
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
cd ..
git add livekit-agent/tests/test_persona.py livekit-agent/tests/test_session_data.py
git commit -m "test(agent): cover 3-persona panel + new questionsByPersona schema"
git push origin master
```

---

### Task 10: Transcript persona badges in ReportView

**Files:** Modify `components/hr/ReportView.tsx`, `app/(practice)/practice/[sessionId]/report/page.tsx`, `app/(hr)/reports/[sessionId]/page.tsx`

- [ ] **Step 1: Extend ReportView's transcript prop**

In `components/hr/ReportView.tsx`, find the `transcript` prop type:

```tsx
transcript: Array<{ role: "user" | "assistant"; content: string; index: number }>;
```

Replace with:

```tsx
transcript: Array<{
  role: "user" | "assistant";
  content: string;
  index: number;
  metadata?: { personaId?: string };
}>;
```

In the JSX where each turn is rendered (look for the `transcript.map` block), add a small persona badge for assistant turns:

```tsx
const PERSONA_LABEL: Record<string, string> = {
  behavioral: "Behavioral",
  technical: "Technical",
  "system-design": "System Design",
  general: "AI",
};

// inside the .map render:
<span className="text-xs uppercase tracking-wider text-fg-subtle mr-2">
  {t.role === "assistant"
    ? PERSONA_LABEL[t.metadata?.personaId ?? "general"] ?? "AI"
    : "Candidate"}
</span>
```

- [ ] **Step 2: Pass turn metadata in both report pages**

In `app/(practice)/practice/[sessionId]/report/page.tsx` AND `app/(hr)/reports/[sessionId]/page.tsx`, find the `transcript` mapping:

```tsx
const transcript = turnsSnap.docs.map(
  (d) =>
    d.data() as {
      role: "user" | "assistant";
      content: string;
      index: number;
    },
);
```

Replace with:

```tsx
const transcript = turnsSnap.docs.map((d) => {
  const data = d.data() as {
    role: "user" | "assistant";
    content: string;
    index: number;
    metadata?: { personaId?: string };
  };
  return data;
});
```

- [ ] **Step 3: Typecheck + commit**

```bash
npx tsc --noEmit
git add components/hr/ReportView.tsx "app/(practice)/practice/[sessionId]/report/page.tsx" "app/(hr)/reports/[sessionId]/page.tsx"
git commit -m "feat(report): transcript turns show persona badges (Behavioral/Technical/SystemDesign)"
git push origin master
```

---

### Task 11: Stale-session graceful fallback

**Files:** Modify `app/(practice)/practice/[sessionId]/page.tsx`

- [ ] **Step 1: Add fallback for sessions without partitioned questions**

In the status router, after fetching the session doc, before the existing status checks:

```tsx
const session = doc.data() as Session;

// Owner check — only the practising user can see this.
if (session.candidateUid !== decoded.uid) notFound();

// Stale-session check: practice mode sessions created before the
// multi-agent rollout don't have questionsByPersona. The Python agent
// will refuse to load them; bounce the user to a fresh practice rather
// than letting them sit in a broken interview.
if (
  session.inviteToken === "practice" &&
  !session.questionsByPersona
) {
  redirect("/practice?stale=1");
}
```

Then in `app/(practice)/practice/page.tsx` (the dashboard), look for the search-params reading code; if there is none, add minimal handling at the top:

```tsx
export default async function PracticeDashboard({
  searchParams,
}: {
  searchParams: Promise<{ stale?: string }>;
}) {
  const sp = await searchParams;
  // ... existing logic
  // (`sp.stale === "1"` is a hint to the UI to render a one-time banner;
  // implementation below is optional — minimum is just to accept the
  // search param without erroring.)
}
```

Keep it minimal — a banner is nice-to-have but not blocking; the redirect already gets the user out of the dead interview state.

- [ ] **Step 2: Typecheck + commit**

```bash
npx tsc --noEmit
git add "app/(practice)/practice/[sessionId]/page.tsx" "app/(practice)/practice/page.tsx"
git commit -m "feat(practice): redirect stale pre-panel sessions to dashboard with stale=1 flag"
git push origin master
```

---

### Task 12: Production build + manual smoke

**Files:** None

- [ ] **Step 1: Production build**

```bash
npx next build
```

Expected: exit 0; all existing practice routes plus any newly-touched routes compile.

- [ ] **Step 2: Python tests full pass**

```bash
cd livekit-agent && .venv/Scripts/python.exe -m pytest -v
```

Expected: all pass.

- [ ] **Step 3: Manual smoke**

Restart Next.js dev and the Python agent worker. Sign in, start a new practice with a real role + JD + CV.

Verify:

1. Behavioral agent (Sarah voice) speaks first, greets the candidate, asks a behavioral question grounded in CV.
2. After 3-6 exchanges, voice changes — Adam introduces himself, asks technical question.
3. After another 3-6 exchanges, voice changes — Bella, asks system design question.
4. End of system design round → session ends, report renders.
5. In the report transcript view, each AI turn shows the right persona label (Behavioral / Technical / System Design); candidate turns show "Candidate".
6. The 5-category report is sensible — totalScore reflects across-round performance.

- [ ] **Step 4: Final commit (no code change)**

```bash
git log --oneline -1
echo "Multi-agent panel smoke: PASS"
```

If anything fails — fix inline, commit, and re-smoke.
