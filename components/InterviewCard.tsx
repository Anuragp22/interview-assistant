import dayjs from "dayjs";
import Link from "next/link";
import Image from "next/image";
import { ArrowRight, Calendar, Star } from "lucide-react";

import DisplayTechIcons from "@/components/DisplayTechIcons";

import { cn, getRandomInterviewCover } from "@/lib/utils";
import { getFeedbackByInterviewId } from "@/lib/actions/general.action";

const InterviewCard = async ({
  interviewId,
  userId,
  role,
  type,
  techstack,
  createdAt,
}: InterviewCardProps) => {
  const feedback =
    userId && interviewId
      ? await getFeedbackByInterviewId({
          interviewId,
          userId,
        })
      : null;

  const normalizedType = /mix/gi.test(type) ? "Mixed" : type;
  const formattedDate = dayjs(
    feedback?.createdAt || createdAt || Date.now()
  ).format("MMM D, YYYY");

  const href = feedback
    ? `/interview/${interviewId}/feedback`
    : `/interview/${interviewId}`;

  return (
    <Link href={href} className="card-interview group">
      <div className="flex flex-col gap-4">
        {/* Header: cover + type chip */}
        <div className="flex items-start justify-between gap-3">
          <Image
            src={getRandomInterviewCover()}
            alt=""
            width={56}
            height={56}
            className="rounded-lg object-cover size-14 ring-1 ring-border-default"
          />
          <span
            className={cn(
              "text-xs font-medium px-2 py-1 rounded-md",
              "bg-accent-soft border border-accent-border text-fg-strong",
            )}
          >
            {normalizedType}
          </span>
        </div>

        {/* Title */}
        <h3 className="text-base font-semibold text-fg-strong capitalize line-clamp-1">
          {role} Interview
        </h3>

        {/* Metadata */}
        <div className="flex items-center gap-4 text-xs text-fg-muted">
          <span className="inline-flex items-center gap-1.5">
            <Calendar className="size-3.5" />
            {formattedDate}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Star
              className={cn(
                "size-3.5",
                feedback ? "text-accent fill-accent" : "text-fg-subtle",
              )}
            />
            {feedback?.totalScore ?? "—"}/100
          </span>
        </div>

        {/* Description / final assessment */}
        <p className="text-sm text-fg-default leading-relaxed line-clamp-2">
          {feedback?.finalAssessment ||
            "You haven't taken this interview yet. Take it now to practice and get scored feedback."}
        </p>
      </div>

      {/* Footer: tech icons + CTA */}
      <div className="flex items-center justify-between gap-3 pt-4 border-t border-border-subtle">
        <DisplayTechIcons techStack={techstack} />
        <span
          className={cn(
            "inline-flex items-center gap-1 text-sm font-medium",
            feedback ? "text-fg-default" : "text-accent",
            "group-hover:gap-2 transition-all",
          )}
        >
          {feedback ? "View feedback" : "Take it"}
          <ArrowRight className="size-3.5" />
        </span>
      </div>
    </Link>
  );
};

export default InterviewCard;
