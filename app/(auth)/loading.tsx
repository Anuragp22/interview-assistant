import { Loader2 } from "lucide-react";

export default function Loading() {
  return (
    <div className="auth-layout">
      <Loader2 className="size-8 animate-spin text-accent" />
    </div>
  );
}
