import { describe, it, expect } from "vitest";

import { judgeVerdictSchema } from "@/constants";
import { segmentByRound, type JudgeTurn } from "@/lib/llm/judge-report";
import {
  COMMUNICATION_CRITERION,
  ROUND_CRITERIA,
  type RoundId,
} from "@/lib/rubric";

// Every round in the vocabulary, presets included — rubric integrity
// holds for all of them, not just the legacy loop.
const ALL_ROUND_IDS = Object.keys(ROUND_CRITERIA) as RoundId[];

// ---------------------------------------------------------------------------
// Round segmentation — the fix that makes the 3-persona panel reach the score.
//
// The agent stamps personaId on every turn. The old judge dropped it and scored
// a flat, round-blind transcript against five generic categories. These tests
// pin the behaviour that stops that regressing.
// ---------------------------------------------------------------------------

function turn(
  role: "user" | "assistant",
  content: string,
  personaId?: string | null,
): JudgeTurn {
  return { role, content, personaId: personaId ?? null };
}

describe("segmentByRound", () => {
  it("routes each turn to the round its persona was running", () => {
    const turns = [
      turn("assistant", "Tell me about a conflict.", "behavioral"),
      turn("user", "I disagreed with my TL about a rewrite.", "behavioral"),
      turn("assistant", "How do you handle idempotency?", "technical"),
      turn("user", "A dedupe key in Redis.", "technical"),
      turn("assistant", "Design a URL shortener.", "system-design"),
      turn("user", "Start with the read/write ratio.", "system-design"),
    ];

    const out = segmentByRound(turns);

    expect(out.behavioral).toHaveLength(2);
    expect(out.technical).toHaveLength(2);
    expect(out.systemDesign).toHaveLength(2);
    expect(out.technical[1].content).toBe("A dedupe key in Redis.");
    expect(out.systemDesign[0].content).toBe("Design a URL shortener.");
  });

  it("maps the agent's 'system-design' persona id to the systemDesign round", () => {
    // The Python agent writes "system-design"; the rubric keys on "systemDesign".
    // A mismatch here would silently drop the entire third round from scoring.
    const out = segmentByRound([turn("user", "answer", "system-design")]);
    expect(out.systemDesign).toHaveLength(1);
    expect(out.behavioral).toHaveLength(0);
  });

  it("carries an unlabelled turn into the round currently in progress", () => {
    // Turns without a personaId (e.g. a greeting emitted before the first
    // persona is stamped) belong to whichever round is active, not to a
    // fourth phantom bucket.
    const turns = [
      turn("assistant", "Hi, I'm Adam.", "technical"),
      turn("user", "Hello.", null),
      turn("user", "Still answering Adam.", null),
    ];
    const out = segmentByRound(turns);
    expect(out.technical).toHaveLength(3);
  });

  it("defaults to the behavioral round before any persona is stamped", () => {
    const out = segmentByRound([turn("assistant", "Welcome.", null)]);
    expect(out.behavioral).toHaveLength(1);
  });

  it("produces empty rounds rather than throwing when a round never happened", () => {
    // A candidate who hangs up during round 1 must still be scorable — the
    // later rounds score 0 for lack of evidence, they don't crash the report.
    const out = segmentByRound([turn("user", "answer", "behavioral")]);
    expect(out.behavioral).toHaveLength(1);
    expect(out.technical).toEqual([]);
    expect(out.systemDesign).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Rubric integrity
// ---------------------------------------------------------------------------

describe("rubric", () => {
  it("scores no protected-class proxy", () => {
    // "Cultural Fit" is the canonical proxy for protected-class discrimination
    // and must never come back. Nor may affect/emotion, which is a prohibited
    // practice in a hiring context under EU AI Act Art. 5(1)(f).
    const banned = [
      "cultural",
      "confidence",
      "personality",
      "attitude",
      "enthusiasm",
      "likeab",
      "accent",
      "fluency",
    ];
    const all = [...ALL_ROUND_IDS.flatMap((r) => ROUND_CRITERIA[r]), COMMUNICATION_CRITERION];
    for (const c of all) {
      for (const word of banned) {
        expect(c.id.toLowerCase()).not.toContain(word);
        expect(c.label.toLowerCase()).not.toContain(word);
      }
    }
  });

  it("gives every criterion exactly six anchors, 0 through 5", () => {
    const all = [...ALL_ROUND_IDS.flatMap((r) => ROUND_CRITERIA[r]), COMMUNICATION_CRITERION];
    expect(all.length).toBeGreaterThan(0);
    for (const c of all) {
      expect(c.anchors).toHaveLength(6);
      for (const a of c.anchors) expect(a.length).toBeGreaterThan(10);
    }
  });

  it("uses unique criterion ids across all rounds", () => {
    // Ids are the join key between the judge's output and the rubric. A
    // collision would silently overwrite one criterion's score with another's.
    const all = [...ALL_ROUND_IDS.flatMap((r) => ROUND_CRITERIA[r]), COMMUNICATION_CRITERION];
    const ids = all.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// Verdict schema — "clear the bar", not a hiring call
// ---------------------------------------------------------------------------

describe("judgeVerdictSchema", () => {
  it("accepts a bar verdict and rejects hiring vocabulary", () => {
    const good = judgeVerdictSchema.safeParse({
      strengths: ["s"],
      areasForImprovement: ["a"],
      finalAssessment: "f",
      focusArea: { title: "t", why: "w", firstStep: "do X" },
      barVerdict: "not-yet",
      barReasoning: "r",
    });
    expect(good.success).toBe(true);

    const bad = judgeVerdictSchema.safeParse({
      strengths: ["s"],
      areasForImprovement: ["a"],
      finalAssessment: "f",
      focusArea: { title: "t", why: "w", firstStep: "do X" },
      barVerdict: "no-hire",
      barReasoning: "r",
    });
    expect(bad.success).toBe(false);
  });

  it("orders focusArea before barVerdict (decode-order guard)", () => {
    // Structured decoding fills fields in schema order — the model must
    // commit to the fix before the verdict, same reasoning as
    // criterionScoreSchema's evidence-before-score.
    const keys = Object.keys(judgeVerdictSchema.shape);
    expect(keys.indexOf("focusArea")).toBeLessThan(keys.indexOf("barVerdict"));
  });
});
