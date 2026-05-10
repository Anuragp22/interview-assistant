"use server";

import { cookies } from "next/headers";
import { FieldValue } from "firebase-admin/firestore";
import { db, auth } from "@/firebase/admin";
import { setUserRole } from "@/lib/admin-claims";

const SESSION_COOKIE = "session";

async function requireUid(): Promise<string> {
  const cookie = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!cookie) throw new Error("Not signed in");
  const decoded = await auth.verifySessionCookie(cookie, true);
  return decoded.uid;
}

/**
 * Atomically: validate invite is pending+unexpired, stamp candidate role,
 * mark invite redeemed, create session doc, return sessionId.
 *
 * The candidate must be signed in BEFORE calling this. The candidate
 * landing page (`take/[token]`) handles sign-in first; this action only
 * runs after auth.
 */
export async function redeemInvite(
  token: string,
): Promise<ActionResult<{ sessionId: string }>> {
  try {
    const candidateUid = await requireUid();

    const out = await db.runTransaction(async (tx) => {
      const inviteRef = db.collection("invites").doc(token);
      const inviteDoc = await tx.get(inviteRef);
      if (!inviteDoc.exists) throw new Error("Invite not found");
      const invite = inviteDoc.data() as Invite;

      if (invite.status !== "pending") {
        throw new Error(`Invite already ${invite.status}`);
      }
      if (new Date(invite.expiresAt) <= new Date()) {
        tx.update(inviteRef, { status: "expired" });
        throw new Error("Invite has expired");
      }
      if (invite.candidateEmail) {
        const userRecord = await auth.getUser(candidateUid);
        if (userRecord.email !== invite.candidateEmail) {
          throw new Error(
            "This invite is locked to a different email address.",
          );
        }
      }

      const sessionRef = db.collection("sessions").doc();
      const now = new Date().toISOString();
      tx.set(sessionRef, {
        id: sessionRef.id,
        templateId: invite.templateId,
        inviteToken: token,
        candidateUid,
        // hrUid duplicated onto the session for cheap rule check on read
        hrUid: invite.hrUid,
        status: "awaiting-cv" as const,
        livekitRoomName: `session-${sessionRef.id}`,
        createdAt: now,
      });

      tx.update(inviteRef, {
        status: "redeemed",
        redeemedByUid: candidateUid,
        redeemedAt: FieldValue.serverTimestamp(),
      });

      // Mirror the role into a Firestore user doc the same way HR signup
      // does, so /users/{uid} stays the canonical profile location.
      const userRef = db.collection("users").doc(candidateUid);
      tx.set(
        userRef,
        {
          role: "candidate",
          updatedAt: now,
        },
        { merge: true },
      );

      return sessionRef.id;
    });

    // Custom claim is set OUTSIDE the transaction (Auth admin call,
    // not part of Firestore txn). Idempotent — running it twice is fine.
    await setUserRole(candidateUid, "candidate");

    return { success: true, data: { sessionId: out } };
  } catch (e) {
    console.error("redeemInvite failed:", e);
    return {
      success: false,
      message: e instanceof Error ? e.message : "Failed to redeem invite",
    };
  }
}
