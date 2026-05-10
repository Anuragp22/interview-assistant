"use client";

import { useState } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Check, Loader2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const ROLE_SUGGESTIONS = [
  "Frontend Developer",
  "Backend Engineer",
  "Full Stack Developer",
  "Data Engineer",
  "Mobile Developer",
  "DevOps Engineer",
  "Machine Learning Engineer",
  "Site Reliability Engineer",
  "Engineering Manager",
];

const LEVELS = ["Junior", "Mid", "Senior"] as const;
const TYPES = ["Technical", "Behavioral", "Mixed"] as const;

const formSchema = z.object({
  role: z.string().min(2, "Role is required"),
  level: z.enum(LEVELS),
  techstack: z.array(z.string()).min(1, "Add at least one technology"),
  type: z.enum(TYPES),
  amount: z.number().int().min(3).max(15),
});

type FormValues = z.infer<typeof formSchema>;

type Props = { userId: string };

const STEPS = [
  { label: "Role" },
  { label: "Stack" },
  { label: "Style" },
  { label: "Review" },
] as const;

export default function InterviewForm({ userId }: Props) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const { control, handleSubmit, watch, setValue, trigger, formState } =
    useForm<FormValues>({
      resolver: zodResolver(formSchema),
      mode: "onTouched",
      defaultValues: {
        role: "",
        level: "Mid",
        techstack: [],
        type: "Mixed",
        amount: 7,
      },
    });

  const values = watch();

  async function next() {
    const fields: Record<number, (keyof FormValues)[]> = {
      0: ["role", "level"],
      1: ["techstack"],
      2: ["type", "amount"],
    };
    const ok = await trigger(fields[step] ?? []);
    if (ok) setStep((s) => Math.min(s + 1, 3));
  }

  function prev() {
    setStep((s) => Math.max(s - 1, 0));
  }

  async function onSubmit(v: FormValues) {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch("/api/interviews/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role: v.role,
          level: v.level,
          techstack: v.techstack.join(","),
          type: v.type,
          amount: v.amount,
          userid: userId,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || "Failed to create interview.");
      }
      // Keep the overlay up through router.push; the form unmounts when the
      // /interview/{id} page mounts, which has its own loading.tsx for any
      // remaining server-render time. Only flip submitting=false on error.
      router.push(`/interview/${json.interviewId}`);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Failed.");
      setSubmitting(false);
    }
  }

  return (
    <>
      {submitting && (
        <SubmittingOverlay role={values.role} amount={values.amount} />
      )}

      <form onSubmit={handleSubmit(onSubmit)} className="card-border">
        <div className="flex flex-col gap-8 p-6 md:p-8">
          <Stepper step={step} />

          {step === 0 && (
            <Step
              title="Who are you interviewing as?"
              hint="The role determines the question style and difficulty."
            >
              <Field label="Role">
                <Controller
                  name="role"
                  control={control}
                  render={({ field }) => (
                    <>
                      <Input
                        list="roles"
                        placeholder="e.g. Frontend Developer"
                        autoFocus
                        {...field}
                      />
                      <datalist id="roles">
                        {ROLE_SUGGESTIONS.map((r) => (
                          <option key={r} value={r} />
                        ))}
                      </datalist>
                    </>
                  )}
                />
                <FieldError message={formState.errors.role?.message} />
              </Field>

              <Field label="Experience level">
                <Controller
                  name="level"
                  control={control}
                  render={({ field }) => (
                    <SegmentedControl
                      options={LEVELS as unknown as string[]}
                      value={field.value}
                      onChange={field.onChange}
                    />
                  )}
                />
              </Field>
            </Step>
          )}

          {step === 1 && (
            <Step
              title="What tech stack should it cover?"
              hint="Add the technologies you want questions to focus on. Press Enter or comma to add."
            >
              <Field label="Tech stack">
                <ChipInput
                  value={values.techstack}
                  onChange={(next) =>
                    setValue("techstack", next, { shouldValidate: true })
                  }
                  placeholder="React, TypeScript, PostgreSQL…"
                />
                <FieldError message={formState.errors.techstack?.message} />
              </Field>
            </Step>
          )}

          {step === 2 && (
            <Step
              title="How should it run?"
              hint="Pick the interview style and how many questions you want."
            >
              <Field label="Interview type">
                <Controller
                  name="type"
                  control={control}
                  render={({ field }) => (
                    <SegmentedControl
                      options={TYPES as unknown as string[]}
                      value={field.value}
                      onChange={field.onChange}
                    />
                  )}
                />
              </Field>

              <Field
                label="Number of questions"
                trailing={
                  <span className="text-fg-strong font-semibold tabular-nums">
                    {values.amount}
                  </span>
                }
              >
                <Controller
                  name="amount"
                  control={control}
                  render={({ field }) => (
                    <RangeSlider
                      min={3}
                      max={15}
                      value={field.value}
                      onChange={field.onChange}
                    />
                  )}
                />
              </Field>
            </Step>
          )}

          {step === 3 && (
            <Step
              title="Review & generate"
              hint="Confirm the details. We'll generate questions and route you to the live room."
            >
              <div className="rounded-lg border border-border-default bg-surface-2/50 divide-y divide-border-subtle">
                <SummaryRow label="Role">{values.role}</SummaryRow>
                <SummaryRow label="Level">{values.level}</SummaryRow>
                <SummaryRow label="Tech stack">
                  <div className="flex flex-wrap gap-1.5 justify-end">
                    {values.techstack.map((t) => (
                      <span
                        key={t}
                        className="text-xs px-2 py-0.5 rounded-md bg-accent-soft border border-accent-border text-fg-strong"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                </SummaryRow>
                <SummaryRow label="Type">{values.type}</SummaryRow>
                <SummaryRow label="Questions">{values.amount}</SummaryRow>
              </div>
              {submitError && (
                <p className="text-sm text-destructive-100">{submitError}</p>
              )}
            </Step>
          )}

          <div className="flex items-center justify-between pt-2 border-t border-border-subtle">
            <Button
              type="button"
              variant="ghost"
              onClick={prev}
              disabled={step === 0 || submitting}
              className="gap-2"
            >
              <ArrowLeft className="size-4" />
              Back
            </Button>
            {step < 3 ? (
              <Button type="button" onClick={next} className="gap-2">
                Continue
                <ArrowRight className="size-4" />
              </Button>
            ) : (
              <Button type="submit" disabled={submitting} className="gap-2">
                {submitting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Generating…
                  </>
                ) : (
                  <>
                    Create interview
                    <ArrowRight className="size-4" />
                  </>
                )}
              </Button>
            )}
          </div>
        </div>
      </form>
    </>
  );
}

/* ---------------------------------------------------------------------------
 * Sub-components
 * ------------------------------------------------------------------------- */

function Stepper({ step }: { step: number }) {
  return (
    <div className="flex items-center gap-3">
      {STEPS.map((s, i) => {
        const status: "done" | "current" | "todo" =
          i < step ? "done" : i === step ? "current" : "todo";
        return (
          <div key={s.label} className="flex items-center gap-3 flex-1">
            <div className="flex items-center gap-2 min-w-0">
              <div
                className={cn(
                  "flex items-center justify-center size-7 rounded-full text-xs font-semibold border transition-colors",
                  status === "done" &&
                    "bg-accent border-accent text-accent-fg",
                  status === "current" &&
                    "bg-accent-soft border-accent-border text-fg-strong",
                  status === "todo" &&
                    "bg-surface-2 border-border-default text-fg-muted",
                )}
              >
                {status === "done" ? (
                  <Check className="size-3.5" strokeWidth={3} />
                ) : (
                  i + 1
                )}
              </div>
              <span
                className={cn(
                  "text-sm font-medium hidden sm:inline",
                  status === "done" && "text-fg-default",
                  status === "current" && "text-fg-strong",
                  status === "todo" && "text-fg-muted",
                )}
              >
                {s.label}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <div
                className={cn(
                  "h-px flex-1 transition-colors",
                  i < step ? "bg-accent" : "bg-border-default",
                )}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function Step({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-6 animate-fadeIn">
      <div className="flex flex-col gap-1">
        <h2 className="text-xl md:text-2xl font-semibold text-fg-strong">
          {title}
        </h2>
        {hint && <p className="text-fg-muted text-sm">{hint}</p>}
      </div>
      <div className="flex flex-col gap-5">{children}</div>
    </div>
  );
}

function Field({
  label,
  trailing,
  children,
}: {
  label: string;
  trailing?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium text-fg-default">{label}</label>
        {trailing}
      </div>
      {children}
    </div>
  );
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="text-sm text-destructive-100">{message}</p>;
}

function SegmentedControl({
  options,
  value,
  onChange,
}: {
  options: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex p-1 rounded-md bg-surface-2 border border-border-default">
      {options.map((o) => {
        const active = value === o;
        return (
          <button
            type="button"
            key={o}
            onClick={() => onChange(o)}
            className={cn(
              "flex-1 px-4 py-2 rounded text-sm font-medium transition-all",
              active
                ? "bg-accent text-accent-fg shadow-sm"
                : "text-fg-muted hover:text-fg-strong hover:bg-surface-3/50",
            )}
          >
            {o}
          </button>
        );
      })}
    </div>
  );
}

function ChipInput({
  value,
  onChange,
  placeholder,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState("");

  function commit() {
    const trimmed = draft.trim().replace(/,$/, "").trim();
    if (!trimmed) return;
    if (value.includes(trimmed)) {
      setDraft("");
      return;
    }
    onChange([...value, trimmed]);
    setDraft("");
  }

  return (
    <div className="flex flex-col gap-2.5">
      <Input
        value={draft}
        placeholder={placeholder}
        onChange={(e) => {
          const v = e.target.value;
          if (v.endsWith(",")) {
            setDraft(v);
            commit();
          } else {
            setDraft(v);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Backspace" && !draft && value.length > 0) {
            onChange(value.slice(0, -1));
          }
        }}
      />
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((chip) => (
            <span
              key={chip}
              className="group inline-flex items-center gap-1.5 bg-accent-soft border border-accent-border text-fg-strong text-sm px-2.5 py-1 rounded-md"
            >
              {chip}
              <button
                type="button"
                aria-label={`Remove ${chip}`}
                onClick={() => onChange(value.filter((c) => c !== chip))}
                className="opacity-50 group-hover:opacity-100 transition-opacity rounded-sm hover:bg-accent/20 p-0.5"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function RangeSlider({
  min,
  max,
  value,
  onChange,
}: {
  min: number;
  max: number;
  value: number;
  onChange: (v: number) => void;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="flex flex-col gap-2">
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className={cn(
          "w-full h-1.5 rounded-full appearance-none cursor-pointer",
          "bg-surface-2 border border-border-default",
          // WebKit thumb
          "[&::-webkit-slider-thumb]:appearance-none",
          "[&::-webkit-slider-thumb]:size-4",
          "[&::-webkit-slider-thumb]:rounded-full",
          "[&::-webkit-slider-thumb]:bg-accent",
          "[&::-webkit-slider-thumb]:border-2",
          "[&::-webkit-slider-thumb]:border-surface-0",
          "[&::-webkit-slider-thumb]:shadow-md",
          "[&::-webkit-slider-thumb]:transition-transform",
          "[&::-webkit-slider-thumb]:hover:scale-110",
          // Firefox thumb
          "[&::-moz-range-thumb]:size-4",
          "[&::-moz-range-thumb]:rounded-full",
          "[&::-moz-range-thumb]:bg-accent",
          "[&::-moz-range-thumb]:border-2",
          "[&::-moz-range-thumb]:border-surface-0",
        )}
        style={{
          background: `linear-gradient(to right, var(--color-accent) 0%, var(--color-accent) ${pct}%, var(--color-surface-2) ${pct}%, var(--color-surface-2) 100%)`,
        }}
      />
      <div className="flex justify-between text-xs text-fg-muted tabular-nums">
        <span>{min}</span>
        <span>{max}</span>
      </div>
    </div>
  );
}

function SummaryRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <span className="text-sm text-fg-muted">{label}</span>
      <span className="text-sm font-medium text-fg-strong text-right">
        {children}
      </span>
    </div>
  );
}

function SubmittingOverlay({
  role,
  amount,
}: {
  role: string;
  amount: number;
}) {
  return (
    <div className="fixed inset-0 z-50 bg-surface-0/80 backdrop-blur-sm flex items-center justify-center animate-fadeIn">
      <div className="card-border max-w-md w-full mx-4">
        <div className="flex flex-col gap-4 items-center text-center p-8">
          <Loader2 className="size-10 animate-spin text-accent" />
          <h3 className="text-lg font-semibold text-fg-strong">
            Generating your interview
          </h3>
          <p className="text-sm text-fg-muted">
            Asking Groq Llama-3.3 70B for {amount} questions tailored to{" "}
            <span className="text-fg-strong font-medium">
              {role || "your role"}
            </span>
            . This usually takes 3–8 seconds.
          </p>
          <p className="text-xs text-fg-subtle">Don&apos;t close this tab.</p>
        </div>
      </div>
    </div>
  );
}
