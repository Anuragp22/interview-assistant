"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Room,
  RoomEvent,
  Track,
  type DisconnectReason,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from "livekit-client";
import { Bot, Mic, MicOff, PhoneOff, Users } from "lucide-react";

import { cn } from "@/lib/utils";

const AGENT_JOIN_TIMEOUT_MS = 10_000;

type ConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "ended"
  | "error";

export default function SessionRoomClient({
  sessionId,
  token,
}: {
  sessionId: string;
  token: string;
}) {
  const router = useRouter();
  const roomRef = useRef<Room | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const endAttemptedRef = useRef(false);

  const [connectionState, setConnectionState] = useState<ConnectionState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [agentSpeaking, setAgentSpeaking] = useState(false);
  const [micEnabled, setMicEnabled] = useState(true);

  useEffect(() => {
    return () => {
      if (watchdogRef.current) clearTimeout(watchdogRef.current);
      roomRef.current?.disconnect();
    };
  }, []);

  async function startCall() {
    setConnectionState("connecting");
    setErrorMessage(null);

    const tokenRes = await fetch(`/api/sessions/${sessionId}/livekit-token`, {
      method: "POST",
    });
    const tokenJson = await tokenRes.json();
    if (!tokenRes.ok || !tokenJson.success) {
      setConnectionState("error");
      setErrorMessage(tokenJson.error ?? "Token mint failed");
      return;
    }

    const room = new Room({ adaptiveStream: true, dynacast: true });
    roomRef.current = room;

    room.on(RoomEvent.Connected, () => {
      setConnectionState("connected");
      watchdogRef.current = setTimeout(() => {
        setConnectionState("error");
        setErrorMessage(
          "AI interviewer didn't join. The agent worker may not be running.",
        );
        roomRef.current?.disconnect();
      }, AGENT_JOIN_TIMEOUT_MS);
    });
    room.on(RoomEvent.ParticipantConnected, () => {
      if (watchdogRef.current) {
        clearTimeout(watchdogRef.current);
        watchdogRef.current = null;
      }
    });
    room.on(RoomEvent.Reconnecting, () => setConnectionState("reconnecting"));
    room.on(RoomEvent.Reconnected, () => setConnectionState("connected"));
    room.on(RoomEvent.Disconnected, async (_reason?: DisconnectReason) => {
      setConnectionState((s) =>
        s === "error" || s === "ended" ? s : "ended",
      );
      if (endAttemptedRef.current) return;
      endAttemptedRef.current = true;
      await fetch(`/api/sessions/${sessionId}/end`, { method: "POST" });
      router.push(`/take/${token}/done`);
    });

    room.on(
      RoomEvent.TrackSubscribed,
      (track: RemoteTrack, _: RemoteTrackPublication, __: RemoteParticipant) => {
        if (track.kind === Track.Kind.Audio && audioElRef.current) {
          track.attach(audioElRef.current);
        }
      },
    );

    try {
      await room.connect(tokenJson.connection.wsUrl, tokenJson.connection.token);
      await room.localParticipant.setMicrophoneEnabled(true);
    } catch (err) {
      setConnectionState("error");
      setErrorMessage(err instanceof Error ? err.message : "Connect failed");
    }
  }

  async function toggleMic() {
    const next = !micEnabled;
    setMicEnabled(next);
    try {
      await roomRef.current?.localParticipant.setMicrophoneEnabled(next);
    } catch {
      setMicEnabled(!next);
    }
  }

  async function endCall() {
    if (watchdogRef.current) clearTimeout(watchdogRef.current);
    const room = roomRef.current;
    if (room) {
      await room.disconnect();
      roomRef.current = null;
    }
    setConnectionState("ended");
    if (endAttemptedRef.current) return;
    endAttemptedRef.current = true;
    await fetch(`/api/sessions/${sessionId}/end`, { method: "POST" });
    router.push(`/take/${token}/done`);
  }

  const isLive = connectionState === "connected" || connectionState === "reconnecting";
  const isLoading = connectionState === "connecting";

  if (!isLive) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-6 px-6">
        <div className="card-border max-w-md w-full">
          <div className="flex flex-col gap-4 p-8 text-center">
            <h1 className="text-xl font-semibold text-fg-strong">
              Ready when you are
            </h1>
            <p className="text-sm text-fg-muted">
              Make sure your microphone is working. The AI will speak first.
            </p>
            <button
              type="button"
              onClick={startCall}
              disabled={isLoading}
              className={cn(
                "inline-flex items-center justify-center gap-2 px-8 py-4",
                "rounded-full bg-accent text-accent-fg text-sm font-semibold",
                "hover:bg-accent-hover active:scale-[0.98] transition-all",
              )}
            >
              <Mic className="size-4" />
              Start interview
            </button>
            {errorMessage && (
              <p className="text-sm text-destructive-100">{errorMessage}</p>
            )}
          </div>
        </div>
        <audio ref={audioElRef} autoPlay playsInline className="hidden" />
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-40 bg-black">
      <audio ref={audioElRef} autoPlay playsInline className="hidden" />
      <div className="absolute inset-0 grid grid-cols-1 md:grid-cols-2 gap-2 p-2 pb-24 md:p-3 md:pb-28">
        <Tile name="AI Interviewer" speaking={agentSpeaking && isLive} icon="bot" />
        <Tile
          name="You"
          speaking={!agentSpeaking && isLive && micEnabled}
          muted={!micEnabled}
        />
      </div>

      <div className="absolute top-4 right-4 z-10 flex flex-col items-end gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 backdrop-blur-sm px-2.5 py-1 text-xs font-medium text-white">
          <Users className="size-3.5" /> 2
        </span>
      </div>

      <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2">
        <button
          type="button"
          onClick={toggleMic}
          aria-label={micEnabled ? "Mute" : "Unmute"}
          className={cn(
            "size-12 rounded-full inline-flex items-center justify-center transition-colors",
            micEnabled
              ? "bg-white/10 text-white hover:bg-white/15"
              : "bg-red-500 text-white hover:bg-red-600",
          )}
        >
          {micEnabled ? <Mic className="size-5" /> : <MicOff className="size-5" />}
        </button>
        <div className="w-2" />
        <button
          type="button"
          onClick={endCall}
          aria-label="End interview"
          className="h-12 px-6 rounded-full bg-red-500 text-white font-semibold text-sm inline-flex items-center gap-2 hover:bg-red-600 transition-colors"
        >
          <PhoneOff className="size-5" /> End
        </button>
      </div>
    </div>
  );
}

function Tile({
  name,
  speaking,
  muted,
  icon,
}: {
  name: string;
  speaking: boolean;
  muted?: boolean;
  icon?: "bot";
}) {
  return (
    <div
      className={cn(
        "relative w-full h-full overflow-hidden bg-neutral-900 rounded-2xl",
        "ring-1 transition-all",
        speaking ? "ring-2 ring-blue-500 shadow-[0_0_40px_-8px_var(--color-accent-soft)]" : "ring-white/[0.04]",
      )}
    >
      <div className="absolute inset-0 flex items-center justify-center">
        <div
          className={cn(
            "flex items-center justify-center rounded-full transition-colors duration-200",
            "size-32 md:size-44",
            speaking ? "bg-blue-500/90 text-white" : "bg-neutral-700 text-neutral-300",
          )}
        >
          {icon === "bot" ? (
            <Bot className="size-1/2" strokeWidth={1.5} />
          ) : null}
        </div>
      </div>
      <div className="absolute bottom-3 left-4 flex items-center gap-2">
        {muted && (
          <span className="size-5 rounded-full bg-red-500 inline-flex items-center justify-center">
            <MicOff className="size-3 text-white" />
          </span>
        )}
        <span className="text-[13px] font-medium text-white drop-shadow-[0_1px_4px_rgba(0,0,0,0.7)]">
          {name}
        </span>
      </div>
    </div>
  );
}
