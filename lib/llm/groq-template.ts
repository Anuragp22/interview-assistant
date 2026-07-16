"use server";

import { generateObject } from "ai";

import {
  partitionedTemplateSchema,
  templateGenerationSchema,
} from "@/constants";
import { withGroqModel } from "@/lib/groq";

/**
 * Phase 1 generation: from role + level + JD only, produce N questions
 * and matching per-question rubrics. CV-grounding happens later at Phase 2
 * (groq-grounding.ts) when the candidate uploads their resume.
 *
 * Uses strict json_schema decoding (structuredOutputs:true). gpt-oss-120b is
 * one of only two Groq models that support it; the schema is enforced during
 * decoding, so the model cannot emit a shape that fails the Zod parse. The
 * inline shape descriptions the old json_object mode needed are no longer
 * load-bearing — the grammar is.
 *
 * The Groq call is wrapped in withGroqModel for multi-account failover
 * (GROQ_API_KEY1/2/3) on a daily-quota 429.
 */
export async function generateQuestionsAndRubrics(input: {
  role: string;
  level: "Junior" | "Mid" | "Senior" | "Staff";
  jobDescription: string;
  count?: number;
}): Promise<{ questions: string[]; rubrics: RubricBase[] }> {
  const count = input.count ?? 8;

  const { object } = await withGroqModel((model) =>
    generateObject({
      model,
      providerOptions: { groq: { structuredOutputs: true } },
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
    }),
  );

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
  const { object } = await withGroqModel((model) =>
    generateObject({
      model,
      providerOptions: { groq: { structuredOutputs: true } },
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
    }),
  );

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
