import { describe, expect, it } from "vitest";

import { zodSchema } from "ai";

import {
  groundingSchema,
  roundsGroundingSchema,
  roundsTemplateSchema,
  templateGenerationSchema,
} from "@/constants";

/**
 * Groq strict-mode invariant: every property of every object node must be
 * listed in `required`.
 *
 * @ai-sdk/groq v3 sends `response_format: json_schema` with `strict: true`
 * by default (structuredOutputs ?? true). Groq rejects the REQUEST with a
 * 400 when any object's `properties` key is missing from `required` — the
 * call fails before any generation happens. A single `.optional()` field in
 * a Groq-bound zod schema therefore breaks the pipeline deterministically
 * (this exact bug shipped once: `cvReference: z.string().optional()` made
 * every phase-2 reground call 400). Model "may omit" semantics must be
 * expressed as `.nullable()` — key always present, `null` allowed.
 *
 * This test derives the JSON schema with the SAME conversion the AI SDK
 * applies at request time (`zodSchema(...).jsonSchema`) and walks it
 * recursively, so the failure class is unrepresentable: any future
 * `.optional()` in a Groq-bound schema fails CI, not production.
 *
 * Gemini-bound schemas (judgeScoresSchema, judgeVerdictSchema) go through
 * a different provider mapping and are deliberately NOT covered here.
 */

// Round-id sets that exercise the dynamic-key schema builders: the classic
// big-tech loop plus a two-round preset shape.
const THREE_ROUNDS = ["behavioral", "technical", "systemDesign"];
const TWO_ROUNDS = ["ownership", "technical"];

const GROQ_BOUND_SCHEMAS: Array<{ name: string; schema: Parameters<typeof zodSchema>[0] }> = [
  { name: "templateGenerationSchema", schema: templateGenerationSchema },
  { name: "groundingSchema", schema: groundingSchema },
  {
    name: "roundsTemplateSchema(behavioral,technical,systemDesign)",
    schema: roundsTemplateSchema(THREE_ROUNDS),
  },
  {
    name: "roundsGroundingSchema(behavioral,technical,systemDesign)",
    schema: roundsGroundingSchema(THREE_ROUNDS),
  },
  { name: "roundsTemplateSchema(ownership,technical)", schema: roundsTemplateSchema(TWO_ROUNDS) },
  { name: "roundsGroundingSchema(ownership,technical)", schema: roundsGroundingSchema(TWO_ROUNDS) },
];

/**
 * Recursively collect strict-mode violations: object nodes whose
 * `properties` contain keys absent from `required`. Also counts the object
 * nodes visited so the test can assert it actually inspected something
 * (guards against the conversion silently producing an empty schema).
 */
function auditNode(
  node: unknown,
  path: string,
  out: { violations: string[]; objectNodes: number },
): void {
  if (node === null || typeof node !== "object") return;

  if (Array.isArray(node)) {
    node.forEach((child, i) => auditNode(child, `${path}[${i}]`, out));
    return;
  }

  const record = node as Record<string, unknown>;
  const properties = record.properties;
  if (properties !== null && typeof properties === "object" && !Array.isArray(properties)) {
    out.objectNodes += 1;
    const required = Array.isArray(record.required) ? (record.required as unknown[]) : [];
    for (const key of Object.keys(properties as Record<string, unknown>)) {
      if (!required.includes(key)) {
        out.violations.push(`${path}.properties.${key} is not listed in required`);
      }
    }
  }

  for (const [key, value] of Object.entries(record)) {
    auditNode(value, `${path}.${key}`, out);
  }
}

describe("Groq strict json_schema invariant — every property must be required", () => {
  for (const { name, schema } of GROQ_BOUND_SCHEMAS) {
    it(`${name}: all object properties appear in required`, () => {
      const json = zodSchema(schema).jsonSchema;
      const audit = { violations: [] as string[], objectNodes: 0 };
      auditNode(json, "$", audit);

      // Sanity: the conversion must have produced at least one object node,
      // otherwise the invariant would pass vacuously.
      expect(audit.objectNodes).toBeGreaterThan(0);
      expect(audit.violations).toEqual([]);
    });
  }
});
