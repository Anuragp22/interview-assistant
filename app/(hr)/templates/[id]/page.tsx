import Link from "next/link";
import { notFound } from "next/navigation";
import { Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import InviteLinkCopy from "@/components/hr/InviteLinkCopy";
import { getTemplate } from "@/lib/actions/templates.action";

export default async function TemplateEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const t = await getTemplate(id);
  if (!t) notFound();

  return (
    <div className="flex flex-col gap-6 max-w-3xl mx-auto w-full">
      <header className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight text-fg-strong">
            {t.title}
          </h1>
          <p className="text-sm text-fg-muted">
            {t.role} · {t.level} ·{" "}
            <span className="capitalize">{t.status}</span>
          </p>
        </div>
        <Button asChild variant="ghost" className="gap-2">
          <Link href={`/templates/${t.id}/candidates`}>
            <Users className="size-4" />
            Candidates
          </Link>
        </Button>
      </header>

      <InviteLinkCopy templateId={t.id} />

      <section className="card-border">
        <div className="flex flex-col gap-3 p-6">
          <h2 className="text-base font-semibold text-fg-strong">
            Generated questions
          </h2>
          <ol className="flex flex-col gap-2 list-decimal list-inside text-sm text-fg-default">
            {t.questionsBase.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ol>
        </div>
      </section>

      <section className="card-border">
        <div className="flex flex-col gap-3 p-6">
          <h2 className="text-base font-semibold text-fg-strong">
            Job description
          </h2>
          <pre className="text-sm whitespace-pre-wrap text-fg-default font-sans">
            {t.jobDescription}
          </pre>
        </div>
      </section>
    </div>
  );
}
