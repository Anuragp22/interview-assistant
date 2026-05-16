"use server";

import { auth } from "@/firebase/admin";

/**
 * Resolve a user's role with a customClaims fallback (no auto-stamp).
 *
 * Step 1: trust JWT.role if present.
 * Step 2: otherwise read customClaims.role from the Auth user record
 *   (catches the case where a candidate's role was stamped after the
 *   current session cookie was minted).
 * Step 3: otherwise return null (caller decides what to do).
 *
 * Practice mode users have no role at all — that's expected. Only the
 * dormant HR/candidate route guards care about role and they redirect
 * the user to /sign-in when null.
 */
export async function resolveRoleForSession(
  decoded: { uid: string } & Record<string, unknown>,
): Promise<"hr" | "candidate" | null> {
  const jwtRole = decoded.role as string | undefined;
  if (jwtRole === "hr" || jwtRole === "candidate") return jwtRole;

  try {
    const userRecord = await auth.getUser(decoded.uid);
    const claimRole = userRecord.customClaims?.role as
      | "hr"
      | "candidate"
      | undefined;
    if (claimRole === "hr" || claimRole === "candidate") return claimRole;
    return null;
  } catch {
    return null;
  }
}
