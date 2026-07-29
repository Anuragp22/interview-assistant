import { ReactNode } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { auth } from "@/firebase/admin";
import DocsLinks from "@/components/DocsLinks";

const AuthLayout = async ({ children }: { children: ReactNode }) => {
    // Push authenticated users into the app so /sign-in is never a dead end.
    const cookie = (await cookies()).get("session")?.value;
    let isAuthed = false;
    if (cookie) {
        try {
            await auth.verifySessionCookie(cookie, true);
            isAuthed = true;
        } catch {
            isAuthed = false;
        }
    }
    // redirect() throws NEXT_REDIRECT — keep it outside the try/catch.
    if (isAuthed) redirect("/practice");

    // Signed-out visitors get the same two doors as the app nav: read how it
    // works, or read the source. Both are reachable before anyone has an account.
    return (
        <div className="relative">
            <DocsLinks className="absolute right-5 top-5 z-10 sm:right-8 sm:top-6" />
            <div className="auth-layout">{children}</div>
        </div>
    );
};

export default AuthLayout;
