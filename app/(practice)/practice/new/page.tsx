import PracticeForm from "@/components/practice/PracticeForm";
import { getSavedCv } from "@/lib/actions/practice.action";

export const dynamic = "force-dynamic";

export default async function NewPracticePage() {
  const cv = await getSavedCv();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2 max-w-2xl mx-auto w-full">
        <h1 className="font-display text-3xl tracking-tight text-fg-strong">
          New practice
        </h1>
        <p className="text-fg-muted text-sm">
          Paste a real job description. We generate questions grounded in
          your CV.
        </p>
      </div>
      <PracticeForm
        savedCv={
          cv ? { filename: cv.filename, uploadedAt: cv.uploadedAt } : null
        }
      />
    </div>
  );
}
