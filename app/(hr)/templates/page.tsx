import Link from "next/link";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { getTemplatesForCurrentHr } from "@/lib/actions/templates.action";

export default async function TemplatesPage() {
  const templates = await getTemplatesForCurrentHr();

  return (
    <div className="flex flex-col gap-6 max-w-5xl mx-auto w-full">
      <div className="flex items-end justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight text-fg-strong">
            Interview templates
          </h1>
          <p className="text-sm text-fg-muted">
            Create a template per role. Send candidates an invite link;
            their report appears here when they finish.
          </p>
        </div>
        <Button asChild size="lg" className="gap-2">
          <Link href="/templates/new">
            <Plus className="size-4" />
            New template
          </Link>
        </Button>
      </div>

      {templates.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {templates.map((t) => (
            <li key={t.id}>
              <Link
                href={`/templates/${t.id}`}
                className="block rounded-xl border border-border-default bg-surface-1 hover:bg-surface-2/60 p-5 transition-colors"
              >
                <div className="flex items-start justify-between gap-3 mb-2">
                  <h2 className="text-base font-semibold text-fg-strong">
                    {t.title}
                  </h2>
                  <span className="text-xs px-2 py-0.5 rounded-md bg-accent-soft border border-accent-border">
                    {t.level}
                  </span>
                </div>
                <p className="text-sm text-fg-muted line-clamp-2">{t.role}</p>
                <p className="text-xs text-fg-subtle mt-2">
                  {t.questionsBase.length} questions ·{" "}
                  {new Date(t.createdAt).toLocaleDateString()}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-xl border border-dashed border-border-default bg-surface-1/40 px-6 py-12 flex flex-col items-center text-center gap-3">
      <h3 className="text-base font-semibold text-fg-strong">
        No templates yet
      </h3>
      <p className="text-sm text-fg-muted max-w-md">
        Create a template by pasting a job description. We&apos;ll generate
        questions and a rubric tailored to the role.
      </p>
      <Button asChild className="mt-2">
        <Link href="/templates/new">Create your first template</Link>
      </Button>
    </div>
  );
}
