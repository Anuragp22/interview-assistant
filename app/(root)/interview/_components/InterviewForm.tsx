"use client";

import { useState } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

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
      {submitting && <SubmittingOverlay role={values.role} amount={values.amount} />}
      <form
      onSubmit={handleSubmit(onSubmit)}
      className="card-border max-w-xl mx-auto"
    >
      <div className="card-content gap-6">
        <Stepper step={step} />

        {step === 0 && (
          <div className="flex flex-col gap-4">
            <label className="label">Role</label>
            <Controller
              name="role"
              control={control}
              render={({ field }) => (
                <>
                  <Input
                    list="roles"
                    placeholder="e.g. Frontend Developer"
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
            {formState.errors.role && (
              <p className="text-sm text-red-400">
                {formState.errors.role.message}
              </p>
            )}

            <label className="label">Experience level</label>
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
          </div>
        )}

        {step === 1 && (
          <div className="flex flex-col gap-4">
            <label className="label">Tech stack</label>
            <ChipInput
              value={values.techstack}
              onChange={(next) =>
                setValue("techstack", next, { shouldValidate: true })
              }
              placeholder="React, TypeScript, …  (Enter or comma to add)"
            />
            {formState.errors.techstack && (
              <p className="text-sm text-red-400">
                {formState.errors.techstack.message}
              </p>
            )}
          </div>
        )}

        {step === 2 && (
          <div className="flex flex-col gap-4">
            <label className="label">Interview type</label>
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

            <label className="label">
              Number of questions: {values.amount}
            </label>
            <Controller
              name="amount"
              control={control}
              render={({ field }) => (
                <input
                  type="range"
                  min={3}
                  max={15}
                  step={1}
                  value={field.value}
                  onChange={(e) => field.onChange(Number(e.target.value))}
                  className="w-full"
                />
              )}
            />
          </div>
        )}

        {step === 3 && (
          <div className="flex flex-col gap-3">
            <h3 className="text-lg font-semibold">Review</h3>
            <SummaryRow label="Role">{values.role}</SummaryRow>
            <SummaryRow label="Level">{values.level}</SummaryRow>
            <SummaryRow label="Tech stack">
              {values.techstack.join(", ")}
            </SummaryRow>
            <SummaryRow label="Type">{values.type}</SummaryRow>
            <SummaryRow label="Questions">{values.amount}</SummaryRow>
            {submitError && (
              <p className="text-sm text-red-400">{submitError}</p>
            )}
          </div>
        )}

        <div className="flex justify-between mt-4">
          <Button
            type="button"
            variant="secondary"
            onClick={prev}
            disabled={step === 0}
          >
            Back
          </Button>
          {step < 3 ? (
            <Button type="button" onClick={next}>
              Next
            </Button>
          ) : (
            <Button type="submit" disabled={submitting}>
              {submitting ? (
                <>
                  <Loader2 className="size-4 mr-2 animate-spin" />
                  Generating…
                </>
              ) : (
                "Create interview"
              )}
            </Button>
          )}
        </div>
      </div>
    </form>
    </>
  );
}

function SubmittingOverlay({ role, amount }: { role: string; amount: number }) {
  return (
    <div className="fixed inset-0 z-50 bg-dark-100/85 backdrop-blur-sm flex items-center justify-center">
      <div className="card-border max-w-md w-full mx-4">
        <div className="card-content gap-4 items-center text-center">
          <Loader2 className="size-10 animate-spin text-primary-100" />
          <h3 className="text-lg font-semibold">Generating your interview</h3>
          <p className="text-sm opacity-70">
            Asking Groq Llama-3.3 70B for {amount} interview questions tailored
            to <span className="font-medium">{role || "your role"}</span>. This
            usually takes 3–8 seconds.
          </p>
          <p className="text-xs opacity-50">
            Don&apos;t close this tab.
          </p>
        </div>
      </div>
    </div>
  );
}

function Stepper({ step }: { step: number }) {
  return (
    <div className="flex gap-2">
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className={cn(
            "h-1.5 flex-1 rounded-full",
            i <= step ? "bg-primary-100" : "bg-dark-300",
          )}
        />
      ))}
    </div>
  );
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
    <div className="flex gap-2">
      {options.map((o) => (
        <button
          type="button"
          key={o}
          onClick={() => onChange(o)}
          className={cn(
            "px-4 py-2 rounded-lg border transition-colors",
            value === o
              ? "bg-primary-100 text-dark-100 border-primary-100"
              : "border-dark-300",
          )}
        >
          {o}
        </button>
      ))}
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
    <div>
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
      <div className="flex flex-wrap gap-2 mt-2">
        {value.map((chip) => (
          <span
            key={chip}
            className="bg-dark-300 px-3 py-1 rounded-full text-sm flex items-center gap-2"
          >
            {chip}
            <button
              type="button"
              aria-label={`Remove ${chip}`}
              onClick={() => onChange(value.filter((c) => c !== chip))}
              className="opacity-60 hover:opacity-100"
            >
              ×
            </button>
          </span>
        ))}
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
    <div className="flex justify-between text-sm">
      <span className="opacity-60">{label}</span>
      <span className="font-medium">{children}</span>
    </div>
  );
}
