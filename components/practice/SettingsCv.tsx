"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FileText, Loader2, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

export default function SettingsCv({
  initialCv,
}: {
  initialCv: { filename: string; uploadedAt: string; size: number } | null;
}) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [cv, setCv] = useState(initialCv);
  const [busy, setBusy] = useState<"replace" | "remove" | null>(null);

  async function onReplace(file: File) {
    setBusy("replace");
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/practice/cv", {
        method: "POST",
        body: fd,
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? "Failed to replace CV");
      }
      setCv({
        filename: json.data.filename,
        uploadedAt: json.data.uploadedAt,
        size: 0,
      });
      toast.success("CV replaced");
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(null);
    }
  }

  async function onRemove() {
    setBusy("remove");
    try {
      const res = await fetch("/api/practice/cv", { method: "DELETE" });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? "Failed to remove CV");
      }
      setCv(null);
      toast.success("CV removed");
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card-border p-5 flex flex-col gap-3">
      <h2 className="text-base font-semibold text-fg-strong">Your CV</h2>

      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onReplace(f);
          e.target.value = "";
        }}
      />

      {cv ? (
        <>
          <div className="flex items-center gap-3 rounded-md bg-surface-2/40 border border-border-default px-3 py-2.5">
            <FileText className="size-4 text-accent shrink-0" />
            <div className="flex-1 min-w-0 flex flex-col">
              <span className="text-sm text-fg-strong truncate">
                {cv.filename}
              </span>
              <span className="text-xs text-fg-subtle">
                uploaded {new Date(cv.uploadedAt).toLocaleDateString()}
              </span>
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={!!busy}
              className="gap-1.5"
            >
              {busy === "replace" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Upload className="size-3.5" />
              )}
              Replace
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onRemove}
              disabled={!!busy}
              className="gap-1.5 text-destructive-100 hover:text-destructive-100"
            >
              {busy === "remove" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Trash2 className="size-3.5" />
              )}
              Remove
            </Button>
          </div>
        </>
      ) : (
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm text-fg-muted">No CV uploaded yet.</p>
          <Button
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={!!busy}
            className="gap-1.5"
          >
            <Upload className="size-3.5" />
            Upload CV
          </Button>
        </div>
      )}
    </div>
  );
}
