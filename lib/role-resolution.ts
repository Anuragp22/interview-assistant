"use server";

import { auth } from "@/firebase/admin";
import { setUserRole } from "@/lib/admin-claims";

/**
 * Resolve a user's role with legacy-account auto-migration.
 *
 * Newer sessions have `role` baked into the verified session cookie as a
 * custom claim. But sessions minted before Task 3 added role-stamping (or
 * any other case where the session cookie predates the claim) won't have
 * it on the JWT — even though the underlying Auth user record may already
 * have the claim, or may legitimately be a legacy HR account that just
 * never got stamped.
 *
 * Two-step resolution:
 *   1. If the JWT itself has `role`, trust it.
 *   2. Otherwise, fetch the Auth user record and read customClaims.role.
 *   3. If even that is missing, treat this as a legacy HR account: stamp
 *      `"hr"` so the user is properly tagged from now on. The current
 *      session cookie still won't carry the claim — but we return "hr"
 *      for this turn so route guards work immediately. Next sign-in mints
 *      a session cookie with the claim baked in.
 *
 * Legacy auto-stamp is only safe because this codebase was HR-only before
 * Task 3, so any pre-claim account is by definition an HR account.
 * Candidate accounts can only be created via /api/invites/.../redeem,
 * which always stamps the role atomically.
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

    // No role anywhere — legacy HR account. Stamp it so this only
    // happens once per user, and treat them as HR for this request.
    await setUserRole(decoded.uid, "hr");
    return "hr";
  } catch {
    return null;
  }
}
