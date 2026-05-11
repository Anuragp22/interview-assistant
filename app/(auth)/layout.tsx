import { ReactNode } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { auth } from "@/firebase/admin";

const AuthLayout = async ({ children }: { children: ReactNode }) => {
    // Only redirect *HR* users away from sign-in/sign-up — they belong on
    // their dashboard. Candidates always land via /take/{token}, never via
    // a generic auth page, so they should still see the form if they hit one
    // by accident (or if their session is stale and they need to re-auth).
    // Sending every authenticated user to "/" caused a redirect loop with
    // app/(root)/page.tsx, which sends non-HR users straight back here.
    const cookie = (await cookies()).get("session")?.value;
    if (cookie) {
        try {
            const decoded = await auth.verifySessionCookie(cookie, true);
            const role = (decoded as Record<string, unknown>).role as
                | string
                | undefined;
            if (role === "hr") redirect("/templates");
        } catch {
            // invalid / expired cookie — fall through and render the form
        }
    }

    return <div className="auth-layout">{children}</div>;
};

export default AuthLayout;
