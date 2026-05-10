"use server";

import { auth } from "@/firebase/admin";

/**
 * Stamp a Firebase Auth user with their role as a custom claim. The claim
 * rides inside the ID token, so route guards can authorize without an
 * extra Firestore read. Per Firebase docs, custom claims are explicitly
 * NOT for profile data — keep this minimal (just the role).
 *
 * Idempotent: setting the same claim twice is a no-op.
 *
 * The user must sign out / refresh their token for the new claim to be
 * visible client-side. Server-side reads via `verifyIdToken` see it
 * immediately on the next call.
 */
export async function setUserRole(uid: string, role: UserRole): Promise<void> {
  await auth.setCustomUserClaims(uid, { role });
}

/**
 * Read a user's role from their existing claims.
 * Returns null if the user has no role set yet (e.g. a brand-new HR
 * account before signUp completes, or a candidate that hasn't redeemed
 * an invite yet).
 */
export async function getUserRole(uid: string): Promise<UserRole | null> {
  const user = await auth.getUser(uid);
  const role = user.customClaims?.role as UserRole | undefined;
  return role ?? null;
}
