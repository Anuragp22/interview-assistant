import { Loader2 } from "lucide-react";

export default function Loading() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-24">
      <Loader2 className="size-8 animate-spin text-accent" />
      <p className="text-sm text-fg-muted">Loading…</p>
    </div>
  );
}
