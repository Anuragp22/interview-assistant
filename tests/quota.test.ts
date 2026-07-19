import { describe, expect, it } from "vitest";

import {
  practiceQuotaDocPath,
  quotaDecision,
  resolveDailyLimit,
} from "@/lib/quota";

describe("practiceQuotaDocPath", () => {
  it("is per-user per-UTC-day", () => {
    expect(practiceQuotaDocPath("u1", new Date("2026-07-17T23:59:00Z"))).toBe(
      "users/u1/quotas/practice-2026-07-17",
    );
  });

  it("rolls over at midnight UTC, not local midnight", () => {
    // 23:59Z and 00:01Z the next day are one minute apart but must land in
    // different buckets — otherwise the reset the message promises is a lie.
    expect(practiceQuotaDocPath("u1", new Date("2026-07-17T23:59:00Z"))).not.toBe(
      practiceQuotaDocPath("u1", new Date("2026-07-18T00:01:00Z")),
    );
    expect(practiceQuotaDocPath("u1", new Date("2026-07-18T00:01:00Z"))).toBe(
      "users/u1/quotas/practice-2026-07-18",
    );
  });

  it("separates users on the same day", () => {
    const day = new Date("2026-07-17T10:00:00Z");
    expect(practiceQuotaDocPath("u1", day)).not.toBe(
      practiceQuotaDocPath("u2", day),
    );
  });
});

describe("quotaDecision", () => {
  it("under limit allowed", () => expect(quotaDecision(4, 5).allowed).toBe(true));
  it("at limit denied", () => expect(quotaDecision(5, 5).allowed).toBe(false));
  it("first session of the day allowed", () =>
    expect(quotaDecision(0, 5).allowed).toBe(true));
  it("over limit denied (counter somehow ahead)", () =>
    expect(quotaDecision(9, 5).allowed).toBe(false));
  it("a zero limit denies everything", () =>
    expect(quotaDecision(0, 0).allowed).toBe(false));
});

describe("resolveDailyLimit", () => {
  it("defaults to 5 when unset", () =>
    expect(resolveDailyLimit(undefined)).toBe(5));
  it("defaults to 5 when blank", () => expect(resolveDailyLimit("  ")).toBe(5));
  it("honours a valid override", () => expect(resolveDailyLimit("12")).toBe(12));
  it("honours an explicit zero (kill switch)", () =>
    expect(resolveDailyLimit("0")).toBe(0));
  // A typo'd env var must not brick every user's practice flow: Number("abc")
  // is NaN, and `used + 1 <= NaN` is false, which would deny everyone forever.
  it("falls back to the default on garbage", () =>
    expect(resolveDailyLimit("abc")).toBe(5));
  it("falls back to the default on a negative", () =>
    expect(resolveDailyLimit("-1")).toBe(5));
  it("falls back to the default on a fraction", () =>
    expect(resolveDailyLimit("2.5")).toBe(5));
});
