import { describe, expect, it } from "vitest";

import { isStaleAwaitingCall } from "@/lib/reconcile-staleness";

const NOW = Date.parse("2026-07-17T12:00:00Z");

describe("isStaleAwaitingCall", () => {
  it("created 2h ago — stale", () =>
    expect(isStaleAwaitingCall("2026-07-17T10:00:00Z", NOW)).toBe(true));

  it("created 10min ago — not stale (user may still click Start)", () =>
    expect(isStaleAwaitingCall("2026-07-17T11:50:00Z", NOW)).toBe(false));

  it("missing createdAt — not stale (never guess-abandon)", () =>
    expect(isStaleAwaitingCall(undefined, NOW)).toBe(false));

  it("unparseable createdAt — not stale (never guess-abandon)", () =>
    expect(isStaleAwaitingCall("not a date", NOW)).toBe(false));

  // Exactly-at-the-boundary stays alive: the sweep abandons a user's session,
  // so ties resolve in favour of leaving it alone.
  it("created exactly 60min ago — not stale (boundary is exclusive)", () =>
    expect(isStaleAwaitingCall("2026-07-17T11:00:00Z", NOW)).toBe(false));

  it("created a hair over 60min ago — stale", () =>
    expect(isStaleAwaitingCall("2026-07-17T10:59:59Z", NOW)).toBe(true));

  // Clock skew between the writer (agent/server) and the reconciler must not
  // read as "created an hour ago".
  it("createdAt in the future — not stale", () =>
    expect(isStaleAwaitingCall("2026-07-17T13:00:00Z", NOW)).toBe(false));
});
