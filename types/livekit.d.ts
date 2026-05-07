// Forward seam (a): typed envelope for LiveKit room data messages.
// Mirrors interview_agent/messages.py. Both sides agree on this shape.

type TurnMessage = {
  type: "turn";
  payload: {
    role: "user" | "assistant";
    content: string;
    index: number;
  };
};

type StatusMessage = {
  type: "status";
  payload: {
    state:
      | "interview_started"
      | "agent_thinking"
      | "agent_speaking"
      | "user_speaking"
      | "interview_ended";
    at: number;
  };
};

type RoomMessage = TurnMessage | StatusMessage;

declare global {
  // Make these ambient so callers don't need to import.
  type RoomTurnMessage = TurnMessage;
  type RoomStatusMessage = StatusMessage;
  type AnyRoomMessage = RoomMessage;
}

export {};
