import { Loader2 } from "lucide-react";

export default function Loading() {
  return (
    <div className="max-w-3xl mx-auto w-full flex flex-col items-center justify-center gap-3 py-20">
      <Loader2 className="size-8 animate-spin text-accent" />
      <p className="text-sm text-fg-muted">Loading your feedback…</p>
    </div>
  );
}
