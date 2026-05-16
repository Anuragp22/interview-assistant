import { ReactNode } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { auth } from "@/firebase/admin";

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

    return <div className="auth-layout">{children}</div>;
};

export default AuthLayout;
