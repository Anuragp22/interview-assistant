"use server";

import { generateObject } from "ai";
import { groq } from "@ai-sdk/groq";

import { templateGenerationSchema } from "@/constants";

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
