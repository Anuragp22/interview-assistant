"use server";

import { generateObject } from "ai";

import { groundingSchema, roundsGroundingSchema } from "@/constants";
import { withGroqModel } from "@/lib/groq";

/**
 * Phase 2: re-ground Phase-1 questions + rubrics in the candidate's
 * actual CV. The output preserves the count and ordering of the input
 * but rewrites questions to reference candidate-specific projects/tech
 * where applicable, and adds a `cvReference` to each rubric noting
 * which CV detail the question targets.
 *
 * Called once per session at CV upload time. The agent reads the
 * grounded versions, never the base versions, at room dispatch. The Groq
 * call is wrapped in withGroqModel for multi-account failover.
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
  const { object } = await withGroqModel((model) =>
    generateObject({
      model,
      providerOptions: { groq: { structuredOutputs: true } },
      schema: groundingSchema,
      experimental_telemetry: {
        isEnabled: true,
        functionId: "groq.reground-questions",
        metadata: { questionCount: input.questionsBase.length },
      },
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
  "questionsGrounded": [<string>, <string>, ...],
  "rubricsGrounded":   [
    {
      "expectedConcepts":  [<string>, ...],
      "expectedSpecifics": [<string>, ...],
      "depth":             "foundational" | "intermediate" | "advanced",
      "priority":          1 | 2 | 3,
      "cvReference":       <string optional>
    },
    ...
  ]
}

Rules:
- questionsGrounded.length MUST equal questionsBase.length and have the same ordering.
- "depth" must be EXACTLY one of: "foundational", "intermediate", "advanced".
  Do not use synonyms like "high", "medium", "low", "easy", "hard".
- "priority" must be the integer 1, 2, or 3.
- Output JSON only — no preamble, no code fences.
    `,
    }),
  );

  return {
    questionsGrounded: object.questionsGrounded,
    rubricsGrounded: object.rubricsGrounded as RubricGrounded[],
  };
}


/**
 * Phase 2 - per-round reground for a preset panel. Takes each round's base
 * questions/rubrics, regrounds them against the CV in a single Groq call,
 * and returns the same round-keyed shape with grounded versions plus an
 * optional cvReference on each rubric.
 */
export async function regroundRoundQuestions(input: {
  questionsByRound: { [roundId: string]: string[] };
  rubricsByRound: { [roundId: string]: RubricBase[] };
  rounds: Array<{ roundId: string; generationFocus: string }>;
  jobDescription: string;
  cvText: string;
}): Promise<{
  [roundId: string]: {
    questionsGrounded: string[];
    rubricsGrounded: RubricGrounded[];
  };
}> {
  const roundIds = input.rounds.map((r) => r.roundId);

  const renderBucket = (roundId: string) => {
    const qs = input.questionsByRound[roundId];
    const rs = input.rubricsByRound[roundId];
    return (
      `## ${roundId}\n` +
      qs
        .map(
          (q, i) =>
            `Q${i + 1}: ${q}\n` +
            `  expectedConcepts: ${rs[i].expectedConcepts.join(", ")}\n` +
            `  expectedSpecifics: ${rs[i].expectedSpecifics.join(", ")}`,
        )
        .join("\n")
    );
  };

  const block = roundIds.map(renderBucket).join("\n\n");

  const { object } = await withGroqModel((model) =>
    generateObject({
      model,
      providerOptions: { groq: { structuredOutputs: true } },
      schema: roundsGroundingSchema(roundIds),
      experimental_telemetry: {
        isEnabled: true,
        functionId: "groq.reground-round-questions",
        metadata: {
          cvLength: input.cvText.length,
          jdLength: input.jobDescription.length,
          rounds: roundIds.join(","),
        },
      },
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

Respond with ONE JSON object whose keys are exactly:
${roundIds.join(", ")}

Each key maps to:
{ "questionsGrounded": [...3 strings...], "rubricsGrounded": [...3 rubric+cvReference objects...] }

Each grounded rubric extends the base rubric with cvReference:
{
  "expectedConcepts":  [<string>, ...],
  "expectedSpecifics": [<string>, ...],
  "depth":             "foundational" | "intermediate" | "advanced",
  "priority":          1 | 2 | 3,
  "cvReference":       "..."
}

Critical rules:
- Preserve question count: 3 per bucket, in original order.
- Reference specific CV details - companies, projects, tech - when natural.
- If a question doesn't map to anything in the CV, keep it close to the base version (don't fabricate CV facts).
- "depth" must be EXACTLY one of "foundational", "intermediate", "advanced" -
  do NOT substitute synonyms like "high", "medium", "low", "easy", "hard".
- "priority" must be the integer 1, 2, or 3.
- Output JSON only.
    `,
    }),
  );

  return object as {
    [roundId: string]: {
      questionsGrounded: string[];
      rubricsGrounded: RubricGrounded[];
    };
  };
}
