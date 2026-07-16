import { NextRequest } from "next/server";

import { db } from "@/firebase/admin";
import { generateReport } from "@/lib/actions/reports.action";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Sessions stuck this long are considered the agent's ping having been lost. */
const AWAITING_REPORT_STALE_MS = 2 * 60 * 1000;

/**
 * A call that never reached awaiting-report within this window had its worker
 * die mid-interview (OOM, deploy, crash). There is no more audio coming, so the
 * turns already on disk are the whole interview — score what we have.
 */
const IN_CALL_STALE_MS = 30 * 60 * 1000;

/** Cap per run so one sweep can't blow maxDuration on a large backlog. */
const MAX_PER_RUN = 10;

/**
 * Report-generation reconciler. Runs on a cron (see vercel.json).
 *
 * Schedule is daily, not every-few-minutes: Vercel Hobby rejects sub-daily
 * cron expressions AT DEPLOY TIME (the deployment fails outright, it isn't
 * throttled). The reconciler is the safety net behind the agent's direct
 * scoring ping, so daily is an acceptable worst-case for a missed report.
 * On a Pro account this can be tightened to something like "*/10 * * * *".
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

  return Response.json({ success: true, reconciled: results.length, results });
}
