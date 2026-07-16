import { AccessToken } from "livekit-server-sdk";

export type RoomConnection = {
  token: string;
  wsUrl: string;
  roomName: string;
};

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
