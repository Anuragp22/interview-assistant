import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock firebase-admin BEFORE importing the unit under test so the
// internal `import { auth } from "@/firebase/admin"` reads our stub.
vi.mock("@/firebase/admin", () => ({
  auth: {
    getUser: vi.fn(),
  },
}));

import { resolveRoleForSession } from "@/lib/role-resolution";
import { auth } from "@/firebase/admin";

const mockedGetUser = vi.mocked(auth.getUser);

describe("resolveRoleForSession", () => {
  beforeEach(() => {
    mockedGetUser.mockReset();
  });

  it("returns 'hr' when the JWT carries role='hr'", async () => {
    const role = await resolveRoleForSession({
      uid: "u1",
      role: "hr",
    });
    expect(role).toBe("hr");
    // Fast path — we never touched the Auth user record.
    expect(mockedGetUser).not.toHaveBeenCalled();
  });

  it("returns 'candidate' when the JWT carries role='candidate'", async () => {
    const role = await resolveRoleForSession({
      uid: "u1",
      role: "candidate",
    });
    expect(role).toBe("candidate");
    expect(mockedGetUser).not.toHaveBeenCalled();
  });

  it("falls back to customClaims.role when JWT has no role", async () => {
    // Fresh candidate case: stamped at invite-redeem time but the existing
    // session cookie was minted earlier, so its JWT has no claim.
    mockedGetUser.mockResolvedValue({
      customClaims: { role: "candidate" },
    } as never);

    const role = await resolveRoleForSession({ uid: "u1" });

    expect(role).toBe("candidate");
    expect(mockedGetUser).toHaveBeenCalledWith("u1");
  });

  it("returns null when neither JWT nor customClaims has a role", async () => {
    // Practice user — by design has no role anywhere.
    mockedGetUser.mockResolvedValue({ customClaims: undefined } as never);

    const role = await resolveRoleForSession({ uid: "u1" });

    expect(role).toBeNull();
  });

  it("returns null and swallows the failure when getUser throws", async () => {
    // Defensive path — Firebase Auth Admin transient errors must not crash
    // route guards. We log and return null; the caller redirects to /sign-in.
    mockedGetUser.mockRejectedValue(new Error("network blip"));

    const role = await resolveRoleForSession({ uid: "u1" });

    expect(role).toBeNull();
  });

  it("ignores invalid role strings on the JWT and tries the fallback", async () => {
    // Belt-and-suspenders: if a stale claim somehow set role='admin' on
    // the JWT (shouldn't happen in our flow), we don't accept it as 'hr'
    // or 'candidate' — we fall through to the customClaims read.
    mockedGetUser.mockResolvedValue({
      customClaims: { role: "hr" },
    } as never);

    const role = await resolveRoleForSession({
      uid: "u1",
      role: "admin",  // not a valid value for our union
    });

    expect(role).toBe("hr");
    expect(mockedGetUser).toHaveBeenCalled();
  });
});
