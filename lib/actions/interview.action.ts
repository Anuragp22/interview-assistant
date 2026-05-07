"use server";

import { mintRoomToken, type RoomConnection } from "@/lib/livekit";
import { getCurrentUser } from "@/lib/actions/auth.action";
import { getInterviewById } from "@/lib/actions/general.action";

type Result =
  | { success: true; connection: RoomConnection }
  | { success: false; message: string };

export async function mintInterviewRoomToken(interviewId: string): Promise<Result> {
  const user = await getCurrentUser();
  if (!user) {
    return { success: false, message: "Not authenticated." };
  }

  const interview = await getInterviewById(interviewId);
  if (!interview) {
    return { success: false, message: "Interview not found." };
  }

  if (interview.userId !== user.id) {
    return { success: false, message: "You don't have access to this interview." };
  }

  const connection = await mintRoomToken({
    interviewId,
    userId: user.id,
    userName: user.name,
    type: interview.type as "Technical" | "Behavioral" | "Mixed",
    questions: interview.questions,
  });

  return { success: true, connection };
}
