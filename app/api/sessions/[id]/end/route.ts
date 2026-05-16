import { NextRequest } from "next/server";
import { cookies } from "next/headers";

import { auth, db } from "@/firebase/admin";
import { generateReport } from "@/lib/actions/reports.action";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;

  const cookie = (await cookies()).get("session")?.value;
  if (!cookie) {
    return Response.json(
      { success: false, error: "Not signed in" },
      { status: 401 },
    );
  }

  let decoded;
  try {
    decoded = await auth.verifySessionCookie(cookie, true);
  } catch {
    return Response.json(
      { success: false, error: "Invalid session" },
      { status: 401 },
    );
  }

  const sessionDoc = await db.collection("sessions").doc(id).get();
  if (!sessionDoc.exists) {
    return Response.json(
      { success: false, error: "Session not found" },
      { status: 404 },
    );
  }
  const session = sessionDoc.data() as Session;
  // Either side of the session (candidate or HR template owner) can end it.
  if (session.candidateUid !== decoded.uid && session.hrUid !== decoded.uid) {
    return Response.json(
      { success: false, error: "Not your session" },
      { status: 403 },
    );
  }

  const r = await generateReport(id);
  if (!r.success) {
    return Response.json({ success: false, error: r.message }, { status: 500 });
  }
  return Response.json({ success: true });
}
