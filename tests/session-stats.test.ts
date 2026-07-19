import { describe, expect, it } from "vitest";

import { formatSessionStats } from "../components/practice/SessionStatsStrip";

describe("formatSessionStats", () => {
  it("full data", () => {
    const rows = formatSessionStats({
      startedAt: "2026-07-17T10:00:00Z",
      endedAt: "2026-07-17T10:23:30Z",
      totalUsd: 0.1234,
      interjections: 4,
      turns: 22,
    });
    expect(rows).toContainEqual({ label: "Duration", value: "23m 30s" });
    expect(rows).toContainEqual({ label: "Interjections", value: "4" });
    expect(rows).toContainEqual({ label: "Turns", value: "22" });
    expect(rows).toContainEqual({ label: "Est. cost", value: "$0.12" });
  });

  it("missing fields are omitted, not rendered as NaN", () => {
    const rows = formatSessionStats({});
    expect(rows).toEqual([]);
  });

  // Telemetry is written on a best-effort teardown path independent of the
  // cost aggregator, so "some fields but not others" is a real state on real
  // sessions, not a hypothetical.
  it("partial data: telemetry present, cost absent", () => {
    const rows = formatSessionStats({ interjections: 0, turns: 18 });
    expect(rows).toEqual([
      { label: "Turns", value: "18" },
      { label: "Interjections", value: "0" },
    ]);
  });

  it("partial data: cost present, telemetry absent", () => {
    const rows = formatSessionStats({
      startedAt: "2026-07-17T10:00:00Z",
      endedAt: "2026-07-17T10:05:00Z",
      totalUsd: 0.4,
    });
    expect(rows).toEqual([
      { label: "Duration", value: "5m 0s" },
      { label: "Est. cost", value: "$0.40" },
    ]);
  });

  it("omits duration when only one endpoint is known", () => {
    expect(formatSessionStats({ startedAt: "2026-07-17T10:00:00Z" })).toEqual([]);
    expect(formatSessionStats({ endedAt: "2026-07-17T10:00:00Z" })).toEqual([]);
  });

  it("omits duration for unparseable or non-positive spans", () => {
    expect(
      formatSessionStats({ startedAt: "not-a-date", endedAt: "2026-07-17T10:00:00Z" }),
    ).toEqual([]);
    // endedAt before startedAt — clock skew between the agent and the client.
    expect(
      formatSessionStats({
        startedAt: "2026-07-17T10:05:00Z",
        endedAt: "2026-07-17T10:00:00Z",
      }),
    ).toEqual([]);
  });

  // Firestore holds whatever the agent last wrote; a NaN that survives the
  // wire must not reach the page as the literal string "NaN".
  it("omits non-finite numbers rather than rendering NaN", () => {
    expect(
      formatSessionStats({ turns: NaN, interjections: NaN, totalUsd: NaN }),
    ).toEqual([]);
    expect(formatSessionStats({ totalUsd: Infinity })).toEqual([]);
  });

  it("does not carry seconds past 60 when rounding up", () => {
    const rows = formatSessionStats({
      startedAt: "2026-07-17T10:00:00.000Z",
      endedAt: "2026-07-17T10:59:59.700Z",
    });
    expect(rows).toEqual([{ label: "Duration", value: "60m 0s" }]);
  });
});
