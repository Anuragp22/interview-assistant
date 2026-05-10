import Link from "next/link";
import { ArrowLeft, Compass } from "lucide-react";

import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="card-border max-w-md w-full">
        <div className="flex flex-col gap-4 items-center text-center p-10">
          <div className="size-12 rounded-full bg-accent-soft border border-accent-border flex items-center justify-center">
            <Compass className="size-5 text-accent" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-fg-strong">
            Page not found
          </h1>
          <p className="text-fg-muted text-sm">
            We couldn&apos;t find what you were looking for. It may have been
            moved or never existed.
          </p>
          <Button asChild variant="ghost" className="mt-2 gap-2">
            <Link href="/">
              <ArrowLeft className="size-4" />
              Back to dashboard
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
