import { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";

import { db } from "@/firebase/admin";
import { generateReport } from "@/lib/actions/reports.action";

export const runtime = "nodejs";
// Scoring is 3 permutation calls (parallel) + 1 verdict call against Gemini
// Flash-Lite — comfortably inside a minute. 60 is also the HARD ceiling on
// the Hobby plan: exporting more fails the whole deployment with "invalid
// maxDuration value". Raise only after moving to Pro.
export const maxDuration = 60;

/**
 * Internal, service-to-service scoring trigger.
 *
 * Called by the Python agent when a call ends, and by the cron reconciler for
 * anything the agent's ping didn't land. NOT called by browsers — there is no
 * session cookie here, because the whole point is that this must work when the
 * browser is gone.
 *
 * Auth is a shared bearer secret rather than a Firebase identity: the caller is
 * a worker process, not a user. `generateReport` is idempotent, so the worst a
 * duplicate call can do is waste a Firestore read.
 */
function authorized(req: NextRequest): boolean {
  const expected = process.env.INTERNAL_API_SECRET;
  if (!expected) return false; // fail closed when unconfigured

  const header = req.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const provided = header.slice(prefix.length);

  // Constant-time compare. Length must match first — timingSafeEqual throws on
  // a length mismatch, and that throw would itself leak length via timing.
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  let sessionId: string;
  try {
    const body = (await req.json()) as { sessionId?: string };
    if (!body.sessionId) throw new Error("missing sessionId");
    sessionId = body.sessionId;
  } catch {
    return Response.json(
      { success: false, error: "Body must be {sessionId: string}" },
      { status: 400 },
    );
  }

  const snap = await db.collection("sessions").doc(sessionId).get();
  if (!snap.exists) {
    return Response.json({ success: false, error: "Session not found" }, { status: 404 });
  }

  const r = await generateReport(sessionId);
  if (!r.success) {
    // Leave status at awaiting-report so the reconciler retries. Returning 500
    // here is what tells the agent's fire-and-forget ping that it failed — but
    // the durable retry does not depend on the agent noticing.
    return Response.json({ success: false, error: r.message }, { status: 500 });
  }
  return Response.json({ success: true, generated: r.data.generated });
}
