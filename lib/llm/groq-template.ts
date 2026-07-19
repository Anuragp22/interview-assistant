"use server";

import { generateObject } from "ai";

import { roundsTemplateSchema, templateGenerationSchema } from "@/constants";
import { withGroqModel } from "@/lib/groq";
import { withSchemaRetry } from "@/lib/llm/schema-retry";

/**
 * Phase 1 generation: from role + level + JD only, produce N questions
 * and matching per-question rubrics. CV-grounding happens later at Phase 2
 * (groq-grounding.ts) when the candidate uploads their resume.
 *
 * Uses strict json_schema decoding (structuredOutputs:true). gpt-oss-120b is
 * one of only two Groq models that support it. CAVEAT: on gpt-oss models
 * Groq validates AFTER generation instead of grammar-constraining it, so the
 * model can still emit invalid JSON and the call 400s with
 * `json_validate_failed` — hence the withSchemaRetry wrapper (bounded,
 * schema-failure-only retries). The inline shape descriptions in the prompt
 * remain load-bearing for the same reason.
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

  const { object } = await withSchemaRetry(
    "groq.generate-questions-and-rubrics",
    () =>
      withGroqModel((model) =>
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
      ),
  );

  return {
    questions: object.questions,
    rubrics: object.rubrics as RubricBase[],
  };
}


/**
 * Phase 1 — per-round generation for a preset panel. Returns one bucket per
 * round id, each with its own questions and base rubrics. One Groq call;
 * the schema is BUILT from the preset's round ids (see roundsTemplateSchema
 * in constants), so strict decoding enforces exactly this panel's shape.
 */
export async function generateRoundQuestions(input: {
  role: string;
  level: "Junior" | "Mid" | "Senior" | "Staff";
  jobDescription: string;
  rounds: Array<{ roundId: string; generationFocus: string }>;
}): Promise<{
  [roundId: string]: { questions: string[]; rubrics: RubricBase[] };
}> {
  const roundIds = input.rounds.map((r) => r.roundId);
  const roundLines = input.rounds
    .map((r, i) => `${i + 1}. ${r.roundId} — ${r.generationFocus}`)
    .join("\n");

  const { object } = await withSchemaRetry(
    "groq.generate-round-questions",
    () =>
      withGroqModel((model) =>
        generateObject({
          model,
          providerOptions: { groq: { structuredOutputs: true } },
          schema: roundsTemplateSchema(roundIds),
          experimental_telemetry: {
            isEnabled: true,
            functionId: "groq.generate-round-questions",
            metadata: {
              role: input.role,
              level: input.level,
              rounds: roundIds.join(","),
            },
          },
          system:
            "You are an expert interviewer designing a multi-round panel.",
          prompt: `
Design an interview panel for a ${input.role} (${input.level}) role. The
panel has ${input.rounds.length} rounds, each conducted by a different
interviewer:

${roundLines}

Generate 3 questions per round, each with a base rubric.

Role: ${input.role} (${input.level})
Job description:
${input.jobDescription}

Respond with ONE JSON object whose keys are exactly:
${roundIds.join(", ")}

Each key maps to: { "questions": [...3 strings...], "rubrics": [...3 rubric objects...] }

Each rubric object has shape:
{
  "expectedConcepts":  ["..."],
  "expectedSpecifics": ["..."],
  "depth":             "foundational" | "intermediate" | "advanced",
  "priority":          1 | 2 | 3
}

Critical rules:
- Each bucket has EXACTLY 3 questions and 3 rubrics, in matching order.
- Questions must match their round's stated focus above.
- Questions about past experience reference real experience, NOT theoretical scenarios.
- Avoid "tell me about X" generics; probe specific tech, decisions, and outcomes.
- Output JSON only - no preamble, no code fences.
    `,
        }),
      ),
  );

  return object as {
    [roundId: string]: { questions: string[]; rubrics: RubricBase[] };
  };
}
