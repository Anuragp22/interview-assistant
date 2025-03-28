"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { signOut } from "@/lib/actions/auth.action";
import { Button } from "./ui/button";

const LogoutButton = () => {
    const [isLoading, setIsLoading] = useState(false);
    const router = useRouter();

    const handleLogout = async () => {
        try {
            setIsLoading(true);
            await signOut();

            toast.success("Signed out successfully.");
            router.push("/sign-in");
            router.refresh();
        } catch (error) {
            console.error("Failed to log out:", error);
            toast.error("Failed to sign out. Please try again.");
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <Button
            onClick={handleLogout}
            disabled={isLoading}
            className="btn-secondary min-w-28"
        >
            {isLoading ? "Signing out..." : "Sign out"}
        </Button>
    );
};

export default LogoutButton;
