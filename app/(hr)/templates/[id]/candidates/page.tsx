import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { notFound } from "next/navigation";

import CandidateRow from "@/components/hr/CandidateRow";
import { getTemplate } from "@/lib/actions/templates.action";
import { getSessionsForTemplate } from "@/lib/actions/sessions.action";

export default async function CandidatesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const template = await getTemplate(id);
  if (!template) notFound();
  const sessions = await getSessionsForTemplate(id);

  return (
    <div className="flex flex-col gap-6 max-w-3xl mx-auto w-full">
      <div className="flex flex-col gap-2">
        <Link
          href={`/templates/${id}`}
          className="inline-flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg-strong w-fit"
        >
          <ArrowLeft className="size-3.5" />
          Back to template
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight text-fg-strong">
          Candidates · {template.title}
        </h1>
      </div>
      {sessions.length === 0 ? (
        <p className="text-sm text-fg-muted">
          No candidates yet. Generate an invite link from the template page
          and send it to a candidate.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {sessions.map((s) => (
            <CandidateRow
              key={s.id}
              session={s}
              candidateName={s.candidateName}
              candidateEmail={s.candidateEmail}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
