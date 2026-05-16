import { describe, it, expect } from "vitest";

import {
  RATES,
  RATES_SOURCED_AT,
  formatUsd,
  groqUsd,
  livekitUsd,
  rollUpCost,
  sttUsd,
  ttsUsd,
} from "@/lib/cost-rates";

describe("groqUsd", () => {
  it("computes input + output token cost at published rates", () => {
    // 1M input + 1M output should equal $0.59 + $0.79 = $1.38
    const usd = groqUsd({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(usd).toBeCloseTo(1.38, 4);
  });

  it("scales linearly with token count", () => {
    const small = groqUsd({ inputTokens: 1_000, outputTokens: 500 });
    const big = groqUsd({ inputTokens: 10_000, outputTokens: 5_000 });
    expect(big).toBeCloseTo(small * 10, 6);
  });

  it("returns 0 for an unknown model rather than throw", () => {
    // Defensive: if a future caller swaps to a model not in the registry
    // we want $0 surfaced so the breakdown still aggregates cleanly,
    // not a crash mid-session.
    // @ts-expect-error — intentionally passing an unknown model
    const usd = groqUsd({ inputTokens: 100, outputTokens: 100, model: "fake" });
    expect(usd).toBe(0);
  });
});

describe("ttsUsd", () => {
  it("matches the published $0.18 / 1k chars rate", () => {
    expect(ttsUsd({ charactersCount: 1_000 })).toBeCloseTo(0.18, 4);
    expect(ttsUsd({ charactersCount: 5_000 })).toBeCloseTo(0.9, 4);
  });
});

describe("sttUsd", () => {
  it("converts seconds to minutes and applies the per-minute rate", () => {
    // 60 seconds * $0.0058/min = $0.0058
    expect(sttUsd({ audioSeconds: 60 })).toBeCloseTo(0.0058, 6);
    // 30 seconds → half rate
    expect(sttUsd({ audioSeconds: 30 })).toBeCloseTo(0.0029, 6);
  });
});

describe("livekitUsd", () => {
  it("charges both participants per minute", () => {
    // 10 min × 2 participants × $0.005 = $0.10
    expect(livekitUsd({ sessionDurationSeconds: 600 })).toBeCloseTo(0.10, 4);
  });
});

describe("rollUpCost", () => {
  it("sums all four legs into a CostBreakdown", () => {
    const breakdown = rollUpCost({
      llmInputTokens: 2_000,
      llmOutputTokens: 1_000,
      ttsCharactersCount: 3_000,
      sttAudioSeconds: 180, // 3 minutes
      sessionDurationSeconds: 600, // 10 minutes
    });

    // Groq: 2000 * 0.59/1M + 1000 * 0.79/1M = 0.00118 + 0.00079 = 0.00197
    expect(breakdown.groqUsd).toBeCloseTo(0.00197, 5);
    // TTS: 3000 * 0.18/1000 = 0.54
    expect(breakdown.ttsUsd).toBeCloseTo(0.54, 4);
    // STT: 3 min * 0.0058 = 0.0174
    expect(breakdown.sttUsd).toBeCloseTo(0.0174, 4);
    // LiveKit: 10 min * 2 * 0.005 = 0.10
    expect(breakdown.livekitUsd).toBeCloseTo(0.10, 4);
    // Total
    expect(breakdown.totalUsd).toBeCloseTo(
      0.00197 + 0.54 + 0.0174 + 0.10,
      4,
    );
    expect(breakdown.ratesSourcedAt).toBe(RATES_SOURCED_AT);
  });

  it("produces a sane breakdown for a tiny session", () => {
    // 1 question, 30 seconds — the smoke-test session.
    const breakdown = rollUpCost({
      llmInputTokens: 500,
      llmOutputTokens: 200,
      ttsCharactersCount: 400,
      sttAudioSeconds: 15,
      sessionDurationSeconds: 30,
    });
    // Total ought to be sub-cent for a 30s pilot interaction.
    expect(breakdown.totalUsd).toBeLessThan(0.10);
    expect(breakdown.totalUsd).toBeGreaterThan(0);
  });
});

describe("formatUsd", () => {
  it("formats normal positive values as $X.YZ", () => {
    expect(formatUsd(0.14)).toBe("$0.14");
    expect(formatUsd(1.5)).toBe("$1.50");
  });

  it("clamps NaN / negative / Infinity to $0.00", () => {
    // Defensive — should never see these in practice, but if Firestore
    // round-trip somehow yields a bad number we render zeros, not NaN.
    expect(formatUsd(Number.NaN)).toBe("$0.00");
    expect(formatUsd(-1)).toBe("$0.00");
    expect(formatUsd(Number.POSITIVE_INFINITY)).toBe("$0.00");
  });
});

describe("RATES registry shape", () => {
  it("has rates dated within the past year", () => {
    // Guardrail: stale prices = silent dashboard rot. If this test fails,
    // pull the current per-provider prices and bump RATES_SOURCED_AT.
    const sourced = new Date(RATES_SOURCED_AT);
    const ageDays = (Date.now() - sourced.getTime()) / (1000 * 60 * 60 * 24);
    expect(ageDays).toBeLessThan(365);
  });

  it("includes the model defaults the agent actually uses", () => {
    expect(RATES.groq).toHaveProperty("llama-3.3-70b-versatile");
    expect(RATES.elevenlabs).toHaveProperty("eleven_turbo_v2_5");
    expect(RATES.deepgram).toHaveProperty("nova-3");
  });
});
