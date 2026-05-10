"use server";

import { generateObject } from "ai";
import { groq } from "@ai-sdk/groq";

import { groundingSchema } from "@/constants";

const GROQ_MODEL = process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile";

/**
 * Phase 2: re-ground Phase-1 questions + rubrics in the candidate's
 * actual CV. The output preserves the count and ordering of the input
 * but rewrites questions to reference candidate-specific projects/tech
 * where applicable, and adds a `cvReference` to each rubric noting
 * which CV detail the question targets.
 *
 * Called once per session at CV upload time. The agent reads the
 * grounded versions, never the base versions, at room dispatch.
 */
export async function regroundQuestions(input: {
  questionsBase: string[];
  rubricsBase: RubricBase[];
  jobDescription: string;
  cvText: string;
}): Promise<{
  questionsGrounded: string[];
  rubricsGrounded: RubricGrounded[];
}> {
  const { object } = await generateObject({
    model: groq(GROQ_MODEL),
    providerOptions: { groq: { structuredOutputs: false } },
    schema: groundingSchema,
    system:
      "You personalise interview questions for a specific candidate. Output a single JSON object exactly matching the schema described in the user message.",
    prompt: `
You are personalising an existing question bank for a specific candidate.

Job description:
${input.jobDescription}

Candidate CV (extracted text):
${input.cvText}

Original (Phase 1) questions and rubrics:
${input.questionsBase
  .map((q, i) => `${i + 1}. ${q}\nRubric: ${JSON.stringify(input.rubricsBase[i])}`)
  .join("\n\n")}

For each question, produce a CV-personalised version. If the candidate's CV mentions a specific project, technology, or company that the question can naturally reference, rewrite the question to cite it (e.g. "Walk me through how the search filters worked at Razorpay" instead of "Tell me about a performance optimization"). When NO clear personalization is possible, leave the question essentially as-is. Every rubric carries forward; you may add a "cvReference" string noting which CV detail the question targets.

Respond as a single JSON object matching this shape exactly:

{
  "questionsGrounded": [<string>, <string>, ...],   // same length as input
  "rubricsGrounded":   [                              // same length as input
    {
      "expectedConcepts":  [...],   // preserve from input
      "expectedSpecifics": [...],   // preserve from input
      "depth":             "...",   // preserve from input
      "priority":          1 | 2 | 3,
      "cvReference":       <string optional>          // e.g. "Razorpay search project (2023)"
    },
    ...
  ]
}

Rules:
- questionsGrounded.length MUST equal questionsBase.length and have the same ordering.
- Output JSON only — no preamble, no code fences.
    `,
  });

  return {
    questionsGrounded: object.questionsGrounded,
    rubricsGrounded: object.rubricsGrounded as RubricGrounded[],
  };
}
