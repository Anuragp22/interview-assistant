"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ArrowRight, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const LEVELS = ["Junior", "Mid", "Senior", "Staff"] as const;

const formSchema = z.object({
  title: z.string().min(3, "Title is required"),
  role: z.string().min(2, "Role is required"),
  level: z.enum(LEVELS),
  jobDescription: z
    .string()
    .min(80, "Paste the full job description (at least ~80 chars)")
    .max(8000, "Job description is too long (8k chars max)"),
});

type Values = z.infer<typeof formSchema>;

export default function TemplateForm() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const { control, handleSubmit, formState } = useForm<Values>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      title: "",
      role: "",
      level: "Mid",
      jobDescription: "",
    },
  });

  async function onSubmit(v: Values) {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch("/api/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(v),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? "Failed to create template");
      }
      router.push(`/templates/${json.templateId}`);
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
            New interview template
          </h2>
          <p className="text-sm text-fg-muted">
            Paste the job description. We generate questions + a rubric
            tailored to the role.
          </p>
        </div>

        <Field label="Internal title">
          <Controller
            control={control}
            name="title"
            render={({ field }) => (
              <Input placeholder="e.g. Frontend Engineer @ Acme" {...field} />
            )}
          />
          {formState.errors.title && (
            <p className="text-xs text-destructive-100">
              {formState.errors.title.message}
            </p>
          )}
        </Field>

        <Field label="Role">
          <Controller
            control={control}
            name="role"
            render={({ field }) => (
              <Input placeholder="e.g. Senior Frontend Engineer" {...field} />
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
                rows={12}
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

        <Button
          type="submit"
          disabled={submitting}
          className="self-end gap-2"
          size="lg"
        >
          {submitting ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Generating questions…
            </>
          ) : (
            <>
              Create template
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
