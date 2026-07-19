/**
 * Staleness rules for the cron reconciler (see app/api/internal/reconcile).
 *
 * These live in lib/ rather than in the route module because the route imports
 * `@/firebase/admin`, which calls `cert()` at module scope and throws without
 * service-account credentials — importing the route into a unit test is not
 * possible without standing up fake creds. Keeping the pure predicate here
 * makes it directly testable and leaves the route as thin glue.
 */

/**
 * awaiting-call means the session doc exists but no call ever started —
 * the user bailed on the pre-call screen, or the agent worker crashed on
 * startup (see agentStartError). After an hour nobody is coming back;
 * without this sweep those rows sit as "Ready to start" forever.
 */
export const AWAITING_CALL_STALE_MS = 60 * 60 * 1000;

/**
 * True when an `awaiting-call` session is old enough to write off.
 *
 * Deliberately conservative: a missing or unparseable `createdAt`, or a
 * timestamp in the future (writer/reconciler clock skew), returns false. This
 * sweep abandons a real user's session, so anything it cannot positively
 * establish as an hour stale is left alone for a human or a later tick.
 */
export function isStaleAwaitingCall(
  createdAt: string | undefined,
  nowMs: number,
): boolean {
  if (!createdAt) return false;
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) return false;
  return nowMs - t > AWAITING_CALL_STALE_MS;
}
