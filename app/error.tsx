"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface unhandled errors in dev console + production error logging.
    console.error("Unhandled app error:", error);
  }, [error]);

  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="card-border max-w-md w-full">
        <div className="flex flex-col gap-4 items-center text-center p-10">
          <div className="size-12 rounded-full bg-destructive-100/15 border border-destructive-100/30 flex items-center justify-center">
            <AlertTriangle className="size-5 text-destructive-100" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-fg-strong">
            Something went wrong
          </h1>
          <p className="text-fg-muted text-sm">
            An unexpected error occurred. You can retry the action or head
            back to the dashboard.
          </p>
          {error.digest && (
            <code className="text-xs px-2 py-1 rounded bg-surface-2 border border-border-default text-fg-muted">
              ref: {error.digest}
            </code>
          )}
          <div className="flex flex-col-reverse sm:flex-row gap-2 mt-2 w-full">
            <Button asChild variant="secondary" className="flex-1 gap-2">
              <Link href="/">
                <ArrowLeft className="size-4" />
                Dashboard
              </Link>
            </Button>
            <Button onClick={reset} className="flex-1 gap-2">
              <RefreshCw className="size-4" />
              Try again
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
