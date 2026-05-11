import { AccessToken } from "livekit-server-sdk";

export type RoomMetadata = {
  interviewId: string;
  userId: string;
  userName: string;
  type: "Technical" | "Behavioral" | "Mixed";
  questions: string[];
};

export type RoomConnection = {
  token: string;
  wsUrl: string;
  roomName: string;
};

export function roomNameFor(interviewId: string, userId: string): string {
  return `interview-${interviewId}-${userId}`;
}

export async function mintRoomToken(metadata: RoomMetadata): Promise<RoomConnection> {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const wsUrl = process.env.NEXT_PUBLIC_LIVEKIT_URL;

  if (!apiKey || !apiSecret || !wsUrl) {
    throw new Error(
      "LiveKit env not configured: LIVEKIT_API_KEY, LIVEKIT_API_SECRET, and NEXT_PUBLIC_LIVEKIT_URL are all required.",
    );
  }

  const roomName = roomNameFor(metadata.interviewId, metadata.userId);

  const at = new AccessToken(apiKey, apiSecret, {
    identity: metadata.userId,
    name: metadata.userName,
    metadata: JSON.stringify(metadata),
    ttl: "30m",
  });
  at.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });

  const token = await at.toJwt();
  return { token, wsUrl, roomName };
}

export async function mintSessionRoomToken(
  sessionId: string,
  candidateUid: string,
  candidateName: string,
): Promise<{
  token: string;
  wsUrl: string;
  roomName: string;
}> {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const wsUrl = process.env.NEXT_PUBLIC_LIVEKIT_URL;
  if (!apiKey || !apiSecret || !wsUrl) {
    throw new Error("LiveKit env vars missing");
  }

  const roomName = `session-${sessionId}`;
  const at = new AccessToken(apiKey, apiSecret, {
    identity: candidateUid,
    name: candidateName,
    metadata: JSON.stringify({ sessionId }),
  });
  at.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });
  const token = await at.toJwt();
  return { token, wsUrl, roomName };
}
