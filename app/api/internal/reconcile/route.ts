import { NextRequest } from "next/server";

import { db } from "@/firebase/admin";
import { generateReport } from "@/lib/actions/reports.action";
import { isStaleAwaitingCall } from "@/lib/reconcile-staleness";

export const runtime = "nodejs";
// 60 is the HARD ceiling on the Hobby plan — exporting more fails the whole
// deployment with "invalid maxDuration value". Raise only after moving to Pro.
export const maxDuration = 60;

/** Sessions stuck this long are considered the agent's ping having been lost. */
const AWAITING_REPORT_STALE_MS = 2 * 60 * 1000;

/**
 * A call that never reached awaiting-report within this window had its worker
 * die mid-interview (OOM, deploy, crash). There is no more audio coming, so the
 * turns already on disk are the whole interview — score what we have.
 */
const IN_CALL_STALE_MS = 30 * 60 * 1000;

/**
 * Cap per run so one sweep can't blow maxDuration on a large backlog. A judge
 * run is ~15-30s (3 parallel permutation calls + a verdict call), and
 * maxDuration is 60s on Hobby — two sequential reports is the safe fit. A
 * deeper backlog drains across subsequent cron ticks.
 */
const MAX_PER_RUN = 2;

/**
 * How many awaiting-call rows to READ per tick before filtering for staleness
 * in memory. Firestore returns docs name-ordered (there is no composite index
 * to orderBy createdAt — see the caveat on the judge sweeps below), so a bare
 * limit(MAX_PER_RUN) could fetch only fresh rows and starve stale ones forever.
 * This sweep does NO judge work, so a wide bounded read is cheap: we scan up to
 * this many rows, then cap the WRITES at MAX_PER_RUN to keep function time
 * bounded.
 */
const AWAITING_CALL_SCAN_LIMIT = 200;

/**
 * Report-generation reconciler. Runs on a cron (see vercel.json).
 *
 * Schedule is daily, not every-few-minutes: Vercel Hobby rejects sub-daily
 * cron expressions AT DEPLOY TIME (the deployment fails outright, it isn't
 * throttled). The reconciler is the safety net behind the agent's direct
 * scoring ping, so daily is an acceptable worst-case for a missed report.
 * On a Pro account this can be tightened to an every-ten-minutes schedule.
 *
 * This is what makes "the report will be generated" a guarantee instead of a
 * hope. The agent pings the score endpoint directly for speed, but that ping can
 * fail — the worker can be OOM-killed between writing awaiting-report and
 * sending it, the network can drop, the deploy can roll. Every one of those
 * leaves a durable awaiting-report marker in Firestore, and this sweep collects
 * them.
 *
 * Vercel Cron sends an `Authorization: Bearer $CRON_SECRET` header.
 */
function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const now = Date.now();
  const results: Array<{ sessionId: string; from: string; ok: boolean; note?: string }> = [];

  // 1. The agent finished the call but the report never landed.
  // Ordering caveat (known limitation): no orderBy("endedAt") — that needs a
  // composite index this project provisions manually, and none exists — so a
  // deep backlog drains in name order, not oldest-first. Acceptable because
  // this sweep calls the judge and limit(MAX_PER_RUN) bounds function time; the
  // index-free widen-in-memory trick used by sweep 3 cannot apply here.
  const awaiting = await db
    .collection("sessions")
    .where("status", "==", "awaiting-report")
    .limit(MAX_PER_RUN)
    .get();

  for (const doc of awaiting.docs) {
    const s = doc.data() as Session;
    const endedAt = s.endedAt ? Date.parse(s.endedAt) : 0;
    // Skip the very recent ones — the agent's own ping is probably in flight,
    // and racing it just burns a duplicate judge call.
    if (endedAt && now - endedAt < AWAITING_REPORT_STALE_MS) continue;

    const r = await generateReport(doc.id);
    results.push({ sessionId: doc.id, from: "awaiting-report", ok: r.success, note: r.success ? undefined : r.message });
  }

  // 2. The worker died mid-call and never even reached awaiting-report.
  // Same ordering caveat as sweep 1: no orderBy("startedAt") without a manual
  // composite index, so a deep backlog drains name-ordered rather than
  // oldest-first. Acceptable for the same reason — this sweep calls the judge
  // and limit(MAX_PER_RUN) bounds function time.
  const inCall = await db
    .collection("sessions")
    .where("status", "==", "in-call")
    .limit(MAX_PER_RUN)
    .get();

  for (const doc of inCall.docs) {
    const s = doc.data() as Session;
    const startedAt = s.startedAt ? Date.parse(s.startedAt) : 0;
    if (!startedAt || now - startedAt < IN_CALL_STALE_MS) continue;

    const turns = await doc.ref.collection("turns").limit(1).get();
    if (turns.empty) {
      // Nothing was ever said. There is no interview to score — don't
      // manufacture a report (and a hire recommendation) out of silence.
      await doc.ref.update({ status: "abandoned" });
      results.push({ sessionId: doc.id, from: "in-call", ok: true, note: "abandoned (no turns)" });
      continue;
    }

    const r = await generateReport(doc.id);
    results.push({ sessionId: doc.id, from: "in-call-stale", ok: r.success, note: r.success ? undefined : r.message });
  }

  // 3. The call never started at all (pre-call bail or agent startup crash).
  //
  // This runs last, after both scoring sweeps have already spent most of the
  // 60s budget. It is safe there because it is abandon-only: no judge call,
  // just a bounded read and at most MAX_PER_RUN Firestore writes. By definition
  // a never-started session has no turns, so there is nothing to score and no
  // report to generate — this pass costs tens of milliseconds, not tens of
  // seconds. If the budget does run out mid-sweep, the only cost is that these
  // rows wait for the next cron tick.
  //
  // Because a bare limit(MAX_PER_RUN) with no ordering would fetch arbitrary
  // (name-ordered) rows and could starve stale rows elsewhere forever, we read
  // a wider page and filter for staleness in memory, then cap the WRITES at
  // MAX_PER_RUN. See AWAITING_CALL_SCAN_LIMIT. No judge work here, so the wider
  // read is cheap and the write cap keeps function time bounded.
  const awaitingCall = await db
    .collection("sessions")
    .where("status", "==", "awaiting-call")
    .limit(AWAITING_CALL_SCAN_LIMIT)
    .get();

  let abandonedCount = 0;
  for (const doc of awaitingCall.docs) {
    if (abandonedCount >= MAX_PER_RUN) break; // cap WRITES, not reads — bounds function time
    const s = doc.data() as Session;
    if (!isStaleAwaitingCall(s.createdAt, now)) continue;

    // Guarded abandon: only write if the row is STILL awaiting-call. A user can
    // click Start in the window between the read above and this write, moving
    // the row awaiting-call → in-call; a blind update would clobber a live
    // call. The transaction re-reads inside the write and no-ops on that race.
    const abandoned = await db.runTransaction(async (tx) => {
      const fresh = await tx.get(doc.ref);
      if (fresh.data()?.status !== "awaiting-call") return false;
      // No turns exist — nothing to score, so no report is manufactured.
      tx.update(doc.ref, { status: "abandoned" });
      return true;
    });
    if (!abandoned) continue;

    abandonedCount++;
    results.push({ sessionId: doc.id, from: "awaiting-call", ok: true, note: "abandoned (never started)" });
  }

  return Response.json({ success: true, reconciled: results.length, results });
}
