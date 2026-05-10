import { redirect } from "next/navigation";

import RoomClient from "./_components/RoomClient";

import {
  getFeedbackByInterviewId,
  getInterviewById,
} from "@/lib/actions/general.action";
import { getCurrentUser } from "@/lib/actions/auth.action";

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
    <div className="flex flex-col gap-6 max-w-4xl mx-auto w-full">
      {/* Compact breadcrumb header — just enough to remind which interview
          this is, without dominating the room view. */}
      <header className="flex items-center gap-2 text-sm text-fg-muted">
        <span className="capitalize text-fg-strong font-medium">
          {interview.role}
        </span>
        <span aria-hidden>·</span>
        <span>{interview.type}</span>
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
