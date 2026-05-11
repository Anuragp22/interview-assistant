import { ReactNode } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { auth } from "@/firebase/admin";
import { resolveRoleForSession } from "@/lib/role-resolution";

const AuthLayout = async ({ children }: { children: ReactNode }) => {
    // Only redirect HR users away from sign-in/sign-up. Candidates always
    // arrive via /take/{token}, so leaving them on the form (if they ever
    // hit it) is the right behavior. Sending every authenticated user to
    // "/" caused a redirect loop with the root page.
    const cookie = (await cookies()).get("session")?.value;
    let role: "hr" | "candidate" | null = null;
    if (cookie) {
        try {
            const decoded = await auth.verifySessionCookie(cookie, true);
            role = await resolveRoleForSession(decoded);
        } catch {
            role = null;
        }
    }
    // redirect() throws NEXT_REDIRECT — keep it OUTSIDE the try/catch
    // so the throw isn't swallowed.
    if (role === "hr") redirect("/templates");

    return <div className="auth-layout">{children}</div>;
};

export default AuthLayout;
