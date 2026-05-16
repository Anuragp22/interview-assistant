"use server";

import { generateObject } from "ai";
import { groq } from "@ai-sdk/groq";

import {
  partitionedTemplateSchema,
  templateGenerationSchema,
} from "@/constants";

const GROQ_MODEL = process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile";

/**
 * Phase 1 generation: from role + level + JD only, produce N questions
 * and matching per-question rubrics. CV-grounding happens later at Phase 2
 * (groq-grounding.ts) when the candidate uploads their resume.
 *
 * Uses Groq json_object mode (structuredOutputs:false) per the
 * @ai-sdk/groq guidance — Llama 3.3 doesn't support json_schema strict
 * mode. The literal word "JSON" is required in the prompt, and the
 * shape is described inline so the model has something to constrain to.
 */
export async function generateQuestionsAndRubrics(input: {
  role: string;
  level: "Junior" | "Mid" | "Senior" | "Staff";
  jobDescription: string;
  count?: number;
}): Promise<{ questions: string[]; rubrics: RubricBase[] }> {
  const count = input.count ?? 8;

  const { object } = await generateObject({
    model: groq(GROQ_MODEL),
    providerOptions: { groq: { structuredOutputs: false } },
    schema: templateGenerationSchema,
    experimental_telemetry: {
      isEnabled: true,
      functionId: "groq.generate-questions-and-rubrics",
      metadata: { role: input.role, level: input.level, count },
    },
    system:
      "You are a senior technical interviewer designing a structured interview rubric. Output a single JSON object exactly matching the schema described in the user message.",
    prompt: `
You are designing the question bank + scoring rubric for an interview at the role/level/JD below.

Generate ${count} questions appropriate for ${input.level} ${input.role}, grounded in the job description. Each question gets a per-question rubric.

Job description:
${input.jobDescription}

Respond as a single JSON object matching this shape exactly:

{
  "questions": [<string>, <string>, ...],
  "rubrics": [
    {
      "expectedConcepts":  [<string>, <string>, ...],   // 2-8 concepts the answer should touch
      "expectedSpecifics": [<string>, <string>, ...],   // 1-6 concrete details (numbers, examples, tools)
      "depth":             "foundational" | "intermediate" | "advanced",
      "priority":          1 | 2 | 3                      // 1=low, 3=high (drives follow-up budget later)
    },
    // ... one rubric per question, in the same order
  ]
}

Rules:
- questions and rubrics arrays must have the same length.
- Cover a mix of priorities — some core (3) and some lighter (1-2).
- Specifics should be concrete (e.g. "mentions retain cycles" not "mentions memory issues").
- Output JSON only — no preamble, no code fences, no trailing prose.
    `,
  });

  return {
    questions: object.questions,
    rubrics: object.rubrics as RubricBase[],
  };
}


/**
 * Phase 1 — partitioned for the 3-agent panel. Returns three buckets
 * (behavioral, technical, systemDesign), each with its own questions
 * and rubrics. Same Groq call, structured 3-bucket output.
 */
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
    experimental_telemetry: {
      isEnabled: true,
      functionId: "groq.generate-partitioned-questions",
      metadata: { role: input.role, level: input.level },
    },
    system:
      "You are an expert technical interviewer designing a 3-round panel.",
    prompt: `
Design an interview panel for a ${input.role} (${input.level}) role. The
panel has THREE rounds, each conducted by a different interviewer:

1. Behavioral - STAR-method probes (situations, tasks, actions, results).
2. Technical - concrete implementation depth (data structures, time
   complexity, language-level decisions).
3. System Design - distributed-systems design, constraints, trade-offs,
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
  "expectedConcepts":  ["..."],
  "expectedSpecifics": ["..."],
  "depth":             "foundational" | "intermediate" | "advanced",
  "priority":          1 | 2 | 3
}

Critical rules:
- Each bucket has EXACTLY 3 questions and 3 rubrics, in matching order.
- Behavioral questions reference past experience, NOT theoretical scenarios.
- Technical questions probe specific tech/patterns; avoid "tell me about X" generics.
- System Design questions are open-ended (no single right answer).
- Output JSON only - no preamble, no code fences.
    `,
  });

  return {
    behavioral: object.behavioral as {
      questions: string[];
      rubrics: RubricBase[];
    },
    technical: object.technical as {
      questions: string[];
      rubrics: RubricBase[];
    },
    systemDesign: object.systemDesign as {
      questions: string[];
      rubrics: RubricBase[];
    },
  };
}
