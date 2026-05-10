"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { LogOut } from "lucide-react";

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
      variant="ghost"
      size="sm"
      onClick={handleLogout}
      disabled={isLoading}
      className="gap-2"
    >
      <LogOut className="size-4" />
      {isLoading ? "Signing out…" : "Sign out"}
    </Button>
  );
};

export default LogoutButton;
