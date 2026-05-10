import { Loader2 } from "lucide-react";

export default function Loading() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-24">
      <Loader2 className="size-10 animate-spin text-primary-100" />
      <h3 className="text-lg font-semibold">Preparing your interview…</h3>
      <p className="text-sm opacity-70">
        Loading questions and warming up the room.
      </p>
    </div>
  );
}
