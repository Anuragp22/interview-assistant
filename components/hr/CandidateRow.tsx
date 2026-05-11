import Link from "next/link";
import dayjs from "dayjs";
import { ArrowRight, Calendar, Clock, FileWarning } from "lucide-react";

import { cn } from "@/lib/utils";

export default function CandidateRow({
  session,
  candidateName,
  candidateEmail,
}: {
  session: Session;
  candidateName: string;
  candidateEmail: string;
}) {
  const statusConfig: Record<Session["status"], { label: string; tone: string }> = {
    "awaiting-cv": { label: "Awaiting CV", tone: "text-fg-muted" },
    "awaiting-call": { label: "CV uploaded", tone: "text-accent" },
    "in-call": { label: "In progress", tone: "text-success-100" },
    completed: { label: "Completed", tone: "text-success-100" },
    abandoned: { label: "Abandoned", tone: "text-destructive-100" },
  };

  return (
    <li>
      <Link
        href={
          session.status === "completed"
            ? `/reports/${session.id}`
            : `#`
        }
        className={cn(
          "flex items-center gap-4 px-4 py-3 rounded-lg border border-border-default bg-surface-1 hover:bg-surface-2/60 transition-colors",
          session.status !== "completed" && "pointer-events-none opacity-70",
        )}
      >
        <div className="flex-1 flex flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-fg-strong">
              {candidateName}
            </span>
            <span className="text-xs text-fg-muted">{candidateEmail}</span>
          </div>
          <div className="flex items-center gap-3 text-xs text-fg-subtle">
            <span className="inline-flex items-center gap-1">
              <Calendar className="size-3" />
              {dayjs(session.createdAt).format("MMM D")}
            </span>
            <span className={cn("inline-flex items-center gap-1", statusConfig[session.status].tone)}>
              <Clock className="size-3" />
              {statusConfig[session.status].label}
            </span>
          </div>
        </div>
        {session.status === "completed" ? (
          <ArrowRight className="size-4 text-fg-muted" />
        ) : session.status === "abandoned" ? (
          <FileWarning className="size-4 text-destructive-100" />
        ) : null}
      </Link>
    </li>
  );
}
