"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, FileText, Loader2, Upload } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export default function CvUploadForm({
  sessionId,
  token,
}: {
  sessionId: string;
  token: string;
}) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [pasteMode, setPasteMode] = useState(false);
  const [pastedText, setPastedText] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      let res: Response;
      if (pasteMode) {
        if (pastedText.trim().length < 50) {
          toast.error("Pasted text is too short.");
          return;
        }
        res = await fetch(`/api/sessions/${sessionId}/cv`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cvText: pastedText }),
        });
      } else {
        if (!file) {
          toast.error("Pick a file or switch to paste mode.");
          return;
        }
        const fd = new FormData();
        fd.append("file", file);
        res = await fetch(`/api/sessions/${sessionId}/cv`, {
          method: "POST",
          body: fd,
        });
      }
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? "Upload failed");
      }
      router.push(`/take/${token}/interview`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card-border max-w-md w-full mx-auto">
      <div className="flex flex-col gap-5 p-8">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold text-fg-strong">
            Upload your CV
          </h1>
          <p className="text-sm text-fg-muted">
            We use your CV to personalise the questions. PDF or DOCX.
          </p>
        </div>

        {!pasteMode && (
          <label
            className={cn(
              "flex flex-col items-center justify-center gap-2",
              "rounded-lg border border-dashed border-border-default bg-surface-2/40",
              "px-6 py-10 cursor-pointer hover:bg-surface-2/60 transition-colors",
              file && "border-accent",
            )}
          >
            <input
              type="file"
              accept="application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              className="hidden"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              disabled={busy}
            />
            {file ? (
              <>
                <FileText className="size-6 text-accent" />
                <span className="text-sm font-medium text-fg-strong">
                  {file.name}
                </span>
                <span className="text-xs text-fg-muted">
                  Click to choose a different file
                </span>
              </>
            ) : (
              <>
                <Upload className="size-6 text-fg-muted" />
                <span className="text-sm text-fg-default">
                  Click to choose a file
                </span>
                <span className="text-xs text-fg-subtle">PDF or DOCX</span>
              </>
            )}
          </label>
        )}

        {pasteMode && (
          <textarea
            placeholder="Paste your CV as plain text..."
            rows={12}
            value={pastedText}
            onChange={(e) => setPastedText(e.target.value)}
            disabled={busy}
            className="w-full rounded-md border border-border-default bg-surface-2 px-3.5 py-2 text-sm text-fg-strong placeholder:text-fg-subtle focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft"
          />
        )}

        <button
          type="button"
          onClick={() => {
            setPasteMode((p) => !p);
            setFile(null);
          }}
          className="text-xs text-accent hover:underline w-fit"
        >
          {pasteMode ? "← Upload a file instead" : "Or paste CV text instead →"}
        </button>

        <Button onClick={submit} disabled={busy} className="gap-2" size="lg">
          {busy ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Personalising your interview…
            </>
          ) : (
            <>
              Continue to interview
              <ArrowRight className="size-4" />
            </>
          )}
        </Button>

        <p className="text-xs text-fg-subtle text-center">
          Personalisation typically takes 5–8 seconds.
        </p>
      </div>
    </div>
  );
}
