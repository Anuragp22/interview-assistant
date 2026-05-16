"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ArrowRight, FileText, Loader2, Upload } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const LEVELS = ["Junior", "Mid", "Senior", "Staff"] as const;

const formSchema = z.object({
  role: z.string().min(2, "Role is required"),
  level: z.enum(LEVELS),
  jobDescription: z
    .string()
    .min(80, "Paste the full job description (at least ~80 chars)")
    .max(8000, "Job description is too long (8k chars max)"),
});

type Values = z.infer<typeof formSchema>;

export default function PracticeForm({
  savedCv,
}: {
  savedCv: { filename: string; uploadedAt: string } | null;
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [useNewCv, setUseNewCv] = useState(!savedCv);
  const [file, setFile] = useState<File | null>(null);

  const { control, handleSubmit, formState } = useForm<Values>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      role: "",
      level: "Mid",
      jobDescription: "",
    },
  });

  async function onSubmit(v: Values) {
    if (useNewCv && !file) {
      toast.error("Please upload a CV file or use your saved one.");
      return;
    }

    setSubmitting(true);
    setSubmitError(null);
    try {
      const fd = new FormData();
      fd.append("role", v.role);
      fd.append("level", v.level);
      fd.append("jobDescription", v.jobDescription);
      if (useNewCv && file) {
        fd.append("file", file);
      }

      const res = await fetch("/api/practice/sessions", {
        method: "POST",
        body: fd,
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? "Failed to start practice");
      }
      router.push(`/practice/${json.data.sessionId}/interview`);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : "Failed");
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      className="card-border max-w-2xl mx-auto w-full"
    >
      <div className="flex flex-col gap-5 p-6 md:p-8">
        <div className="flex flex-col gap-1">
          <h2 className="text-xl font-semibold text-fg-strong">
            New practice
          </h2>
          <p className="text-sm text-fg-muted">
            Generation typically takes 5–15 seconds.
          </p>
        </div>

        <Field label="Role">
          <Controller
            control={control}
            name="role"
            render={({ field }) => (
              <Input
                placeholder="e.g. Senior Frontend Engineer"
                {...field}
              />
            )}
          />
          {formState.errors.role && (
            <p className="text-xs text-destructive-100">
              {formState.errors.role.message}
            </p>
          )}
        </Field>

        <Field label="Level">
          <Controller
            control={control}
            name="level"
            render={({ field }) => (
              <div className="flex p-1 rounded-md bg-surface-2 border border-border-default">
                {LEVELS.map((l) => (
                  <button
                    type="button"
                    key={l}
                    onClick={() => field.onChange(l)}
                    className={cn(
                      "flex-1 px-4 py-2 rounded text-sm font-medium transition-all",
                      field.value === l
                        ? "bg-accent text-accent-fg shadow-sm"
                        : "text-fg-muted hover:text-fg-strong",
                    )}
                  >
                    {l}
                  </button>
                ))}
              </div>
            )}
          />
        </Field>

        <Field label="Job description">
          <Controller
            control={control}
            name="jobDescription"
            render={({ field }) => (
              <textarea
                {...field}
                rows={10}
                placeholder="Paste the full JD..."
                className="w-full rounded-md border border-border-default bg-surface-2 px-3.5 py-2 text-sm text-fg-strong placeholder:text-fg-subtle focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft"
              />
            )}
          />
          {formState.errors.jobDescription && (
            <p className="text-xs text-destructive-100">
              {formState.errors.jobDescription.message}
            </p>
          )}
        </Field>

        <Field label="Your CV">
          {useNewCv ? (
            <>
              <label
                className={cn(
                  "flex flex-col items-center justify-center gap-2",
                  "rounded-lg border border-dashed border-border-default bg-surface-2/40",
                  "px-6 py-8 cursor-pointer hover:bg-surface-2/60 transition-colors",
                  file && "border-accent",
                )}
              >
                <input
                  type="file"
                  accept="application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  className="hidden"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  disabled={submitting}
                />
                {file ? (
                  <>
                    <FileText className="size-5 text-accent" />
                    <span className="text-sm font-medium text-fg-strong">
                      {file.name}
                    </span>
                  </>
                ) : (
                  <>
                    <Upload className="size-5 text-fg-muted" />
                    <span className="text-sm text-fg-default">
                      PDF or DOCX
                    </span>
                  </>
                )}
              </label>
              {savedCv && (
                <button
                  type="button"
                  onClick={() => {
                    setUseNewCv(false);
                    setFile(null);
                  }}
                  className="text-xs text-accent hover:underline w-fit"
                >
                  ← Use saved CV ({savedCv.filename})
                </button>
              )}
            </>
          ) : (
            <div className="flex items-center justify-between gap-3 rounded-md bg-surface-2/40 border border-border-default px-3 py-2.5">
              <div className="flex items-center gap-2 min-w-0">
                <FileText className="size-4 text-accent shrink-0" />
                <span className="text-sm text-fg-strong truncate">
                  {savedCv?.filename}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setUseNewCv(true)}
                className="text-xs text-accent hover:underline whitespace-nowrap"
              >
                Use different CV
              </button>
            </div>
          )}
        </Field>

        <Button
          type="submit"
          disabled={submitting}
          className="self-end gap-2"
          size="lg"
        >
          {submitting ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Personalising your interview…
            </>
          ) : (
            <>
              Start interview
              <ArrowRight className="size-4" />
            </>
          )}
        </Button>

        {submitError && (
          <p className="text-sm text-destructive-100">{submitError}</p>
        )}
      </div>
    </form>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-sm font-medium text-fg-default">{label}</label>
      {children}
    </div>
  );
}
