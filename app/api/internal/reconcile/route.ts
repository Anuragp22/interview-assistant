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
  // 60s budget. It is safe there because it is abandon-only: one indexed query
  // plus at most MAX_PER_RUN Firestore updates, no judge call. By definition a
  // never-started session has no turns, so there is nothing to score and no
  // report to generate — this pass costs tens of milliseconds, not tens of
  // seconds. If the budget does run out mid-sweep, the only cost is that these
  // rows wait for the next cron tick.
  const awaitingCall = await db
    .collection("sessions")
    .where("status", "==", "awaiting-call")
    .limit(MAX_PER_RUN)
    .get();

  for (const doc of awaitingCall.docs) {
    const s = doc.data() as Session;
    if (!isStaleAwaitingCall(s.createdAt, now)) continue;
    // No turns exist — nothing to score, so no report is manufactured.
    await doc.ref.update({ status: "abandoned" });
    results.push({ sessionId: doc.id, from: "awaiting-call", ok: true, note: "abandoned (never started)" });
  }

  return Response.json({ success: true, reconciled: results.length, results });
}
