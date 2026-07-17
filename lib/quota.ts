/**
 * Per-user daily practice-session quota.
 *
 * Session creation burns two Groq LLM calls (question generation + CV
 * regrounding) plus Firestore writes, and the resulting live session burns
 * TTS/STT/judge dollars. Cost telemetry MEASURES that spend; this is the only
 * thing that BOUNDS it. Firestore counter (no new vendor): one doc per user
 * per UTC day, incremented transactionally.
 *
 * `@/firebase/admin` is imported lazily inside `consumePracticeQuota` rather
 * than at module scope: that module initialises the Admin SDK as an import
 * side effect and throws without service-account env, which would make the
 * pure helpers below untestable in the node-environment vitest suite.
 */

const DEFAULT_PRACTICE_DAILY_LIMIT = 5;

/**
 * A misconfigured env var must not brick the product. `Number("abc")` is NaN
 * and `used + 1 <= NaN` is false, so a typo would silently deny every user
 * forever — an outage, not a safety measure. Anything that isn't a
 * non-negative integer falls back to the default; the quota stays enforced
 * either way, so spend stays bounded.
 */
export function resolveDailyLimit(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_PRACTICE_DAILY_LIMIT;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_PRACTICE_DAILY_LIMIT;
}

export const PRACTICE_DAILY_LIMIT = resolveDailyLimit(
  process.env.PRACTICE_DAILY_LIMIT,
);

export function practiceQuotaDocPath(uid: string, now: Date): string {
  const day = now.toISOString().slice(0, 10);
  return `users/${uid}/quotas/practice-${day}`;
}

export function quotaDecision(used: number, limit: number): { allowed: boolean } {
  return { allowed: used + 1 <= limit };
}

/**
 * The outcome of trying to spend one unit of quota.
 *
 * "denied" and "unavailable" are deliberately distinct: the first is the
 * user's own fault and tells them when it resets, the second is ours and
 * means "retry". Collapsing them would tell a user they'd hit a limit they
 * hadn't.
 */
export type QuotaOutcome =
  | { outcome: "allowed"; used: number; limit: number }
  | { outcome: "denied"; used: number; limit: number }
  | { outcome: "unavailable"; limit: number };

export async function consumePracticeQuota(uid: string): Promise<QuotaOutcome> {
  const limit = PRACTICE_DAILY_LIMIT;
  try {
    const { db } = await import("@/firebase/admin");
    const ref = db.doc(practiceQuotaDocPath(uid, new Date()));
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const used = (snap.data()?.count as number | undefined) ?? 0;
      if (!quotaDecision(used, limit).allowed) {
        // No write: a denied attempt must not push the counter further up,
        // or a user who keeps retrying would extend their own lockout.
        return { outcome: "denied" as const, used, limit };
      }
      tx.set(ref, { count: used + 1 }, { merge: true });
      return { outcome: "allowed" as const, used: used + 1, limit };
    });
  } catch (e) {
    // Fail closed: an unenforceable quota is no quota. The user can retry.
    console.error("consumePracticeQuota failed:", e);
    return { outcome: "unavailable", limit };
  }
}
