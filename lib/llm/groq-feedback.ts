"use server";

import { generateObject } from "ai";
import { groq } from "@ai-sdk/groq";

import { reportSchema } from "@/constants";

const GROQ_MODEL = process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile";

export async function generateReportFromTranscript(input: {
  template: Pick<Template, "role" | "level" | "jobDescription">;
  rubricsGrounded: RubricGrounded[];
  questionsGrounded: string[];
  transcript: Array<{ role: "user" | "assistant"; content: string }>;
}): Promise<Omit<Report, "sessionId" | "generatedAt">> {
  const transcriptText = input.transcript
    .map((t) => `- ${t.role}: ${t.content}`)
    .join("\n");

  const rubricBlock = input.rubricsGrounded
    .map(
      (r, i) =>
        `Q${i + 1}: ${input.questionsGrounded[i]}\n` +
        `  expectedConcepts: ${r.expectedConcepts.join(", ")}\n` +
        `  expectedSpecifics: ${r.expectedSpecifics.join(", ")}\n` +
        `  depth: ${r.depth}, priority: ${r.priority}`,
    )
    .join("\n\n");

  const { object } = await generateObject({
    model: groq(GROQ_MODEL),
    providerOptions: { groq: { structuredOutputs: false } },
    schema: reportSchema,
    system:
      "You are a rigorous interview-evaluation engine. Output a single JSON object exactly matching the schema described in the user message.",
    prompt: `
Analyze the interview transcript below and produce a structured report.

Role: ${input.template.role} (${input.template.level})

Question agenda + rubrics:
${rubricBlock}

Transcript:
${transcriptText}

Respond with ONE JSON object matching this exact shape:

{
  "totalScore": <int 0-100>,
  "categoryScores": [
    { "name": "Communication Skills",  "score": <int 0-100>, "comment": "<2-4 sentences>" },
    { "name": "Technical Knowledge",   "score": <int 0-100>, "comment": "<2-4 sentences>" },
    { "name": "Problem Solving",       "score": <int 0-100>, "comment": "<2-4 sentences>" },
    { "name": "Cultural Fit",          "score": <int 0-100>, "comment": "<2-4 sentences>" },
    { "name": "Confidence and Clarity","score": <int 0-100>, "comment": "<2-4 sentences>" }
  ],
  "strengths": ["<bullet>", "..."],
  "areasForImprovement": ["<bullet>", "..."],
  "finalAssessment": "<2-4 sentence overall summary>",
  "recommendation": "strong-hire" | "hire" | "lean-hire" | "lean-no-hire" | "no-hire" | "inconclusive",
  "recommendationReasoning": "<2-3 sentence justification of the recommendation>",
  "rubricCoverage": {
    "Q1": { "<concept>": true, "<other>": false },
    "Q2": { }
  }
}

Critical rules:
- categoryScores names must be EXACTLY those five strings.
- rubricCoverage keys are "Q1", "Q2", etc. matching the rubric block above.
- For each Qn, list each expectedConcept from the rubric and mark whether
  the transcript covered it (true) or not (false).
- Output JSON only — no preamble, no code fences.
    `,
  });

  return object as unknown as Omit<Report, "sessionId" | "generatedAt">;
}
