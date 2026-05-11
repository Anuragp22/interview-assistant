import { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { db, auth } from "@/firebase/admin";
import { mintSessionRoomToken } from "@/lib/livekit";
import { resolveRoleForSession } from "@/lib/role-resolution";

export const runtime = "nodejs";

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const sessionCookie = (await cookies()).get("session")?.value;
  if (!sessionCookie) {
    return Response.json({ success: false, error: "Not signed in" }, { status: 401 });
  }
  const decoded = await auth.verifySessionCookie(sessionCookie, true);
  const role = await resolveRoleForSession(decoded);
  if (role !== "candidate") {
    return Response.json({ success: false, error: "Candidate only" }, { status: 403 });
  }

  const sessionDoc = await db.collection("sessions").doc(id).get();
  if (!sessionDoc.exists) {
    return Response.json({ success: false, error: "Session not found" }, { status: 404 });
  }
  const session = sessionDoc.data() as Session;
  if (session.candidateUid !== decoded.uid) {
    return Response.json({ success: false, error: "Not your session" }, { status: 403 });
  }
  if (session.status !== "awaiting-call" && session.status !== "in-call") {
    return Response.json(
      { success: false, error: `Session status is ${session.status}` },
      { status: 409 },
    );
  }

  const userRecord = await auth.getUser(decoded.uid);
  const { token, wsUrl, roomName } = await mintSessionRoomToken(
    id,
    decoded.uid,
    userRecord.displayName ?? userRecord.email ?? "Candidate",
  );

  return Response.json({
    success: true,
    connection: { token, wsUrl, roomName },
  });
}
