import Image from "next/image";
import { redirect } from "next/navigation";

import RoomClient from "./_components/RoomClient";
import { getRandomInterviewCover } from "@/lib/utils";

import {
  getFeedbackByInterviewId,
  getInterviewById,
} from "@/lib/actions/general.action";
import { getCurrentUser } from "@/lib/actions/auth.action";
import DisplayTechIcons from "@/components/DisplayTechIcons";

const InterviewDetails = async ({ params }: RouteParams) => {
  const { id } = await params;

  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");

  const interview = await getInterviewById(id);
  if (!interview) redirect("/");

  const feedback = await getFeedbackByInterviewId({
    interviewId: id,
    userId: user.id,
  });

  return (
    <div className="flex flex-col gap-8 max-w-4xl mx-auto w-full">
      <header className="flex flex-col sm:flex-row gap-4 sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <Image
            src={getRandomInterviewCover()}
            alt=""
            width={48}
            height={48}
            className="rounded-lg object-cover size-12 ring-1 ring-border-default"
          />
          <div className="flex flex-col gap-1">
            <h1 className="text-xl md:text-2xl font-semibold tracking-tight text-fg-strong capitalize">
              {interview.role} Interview
            </h1>
            <div className="flex items-center gap-3">
              <DisplayTechIcons techStack={interview.techstack} />
              <span className="inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-md bg-accent-soft border border-accent-border text-fg-strong">
                {interview.type}
              </span>
            </div>
          </div>
        </div>
      </header>

      <RoomClient
        interviewId={id}
        userId={user.id}
        userName={user.name}
        feedbackId={feedback?.id}
      />
    </div>
  );
};

export default InterviewDetails;
