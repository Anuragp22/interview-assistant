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
import { toast } from "sonner";
import { Bot, Info, Mic, MicOff, PhoneOff, Users } from "lucide-react";

import { mintInterviewRoomToken } from "@/lib/actions/interview.action";
import { createFeedback } from "@/lib/actions/general.action";
import { cn } from "@/lib/utils";
import PreCallReadyScreen from "./PreCallReadyScreen";

const AGENT_JOIN_TIMEOUT_MS = 10_000;

type ConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "ended"
  | "error";

type Props = {
  interviewId: string;
  userId: string;
  userName: string;
  feedbackId?: string;
};

type Turn = { role: "user" | "assistant"; content: string; index: number };

export default function RoomClient({
  interviewId,
  userId,
  userName,
  feedbackId,
}: Props) {
  const router = useRouter();
  const roomRef = useRef<Room | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const agentWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const feedbackAttemptedRef = useRef(false);

  const [connectionState, setConnectionState] =
    useState<ConnectionState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [agentSpeaking, setAgentSpeaking] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [micEnabled, setMicEnabled] = useState(true);
  const [now, setNow] = useState(() => new Date());

  // Tick a duration counter while connected.
  useEffect(() => {
    if (connectionState !== "connected") return;
    const start = Date.now() - elapsedMs;
    const id = setInterval(() => setElapsedMs(Date.now() - start), 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionState]);

  // Tick wall-clock for the bottom-left "11:14 AM" display.
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  async function runFeedbackFlow() {
    if (feedbackAttemptedRef.current) return;
    feedbackAttemptedRef.current = true;

    const result = await createFeedback({
      interviewId,
      userId,
      feedbackId,
    });
    if (result.success && result.feedbackId) {
      router.push(`/interview/${interviewId}/feedback`);
    } else {
      toast.error("Couldn't generate feedback for this interview.", {
        description:
          "We couldn't build a feedback report from this session. " +
          "This usually means no conversation was captured. " +
          "Try the interview again, or check your interview history.",
        duration: 8000,
      });
      router.push("/");
    }
  }

  async function startCall() {
    if (
      connectionState !== "idle" &&
      connectionState !== "ended" &&
      connectionState !== "error"
    )
      return;

    setConnectionState("connecting");
    setErrorMessage(null);
    setTurns([]);
    setElapsedMs(0);
    setMicEnabled(true);
    feedbackAttemptedRef.current = false;

    const result = await mintInterviewRoomToken(interviewId);
    if (!result.success) {
      setConnectionState("error");
      setErrorMessage(result.message);
      feedbackAttemptedRef.current = true;
      return;
    }

    const room = new Room({ adaptiveStream: true, dynacast: true });
    roomRef.current = room;

    room.on(RoomEvent.Connected, () => {
      setConnectionState("connected");
      agentWatchdogRef.current = setTimeout(() => {
        setConnectionState("error");
        setErrorMessage(
          "AI interviewer did not join. The interview-agent worker may not be running. " +
            "Try again in a moment or check the agent service logs.",
        );
        feedbackAttemptedRef.current = true;
        roomRef.current?.disconnect();
      }, AGENT_JOIN_TIMEOUT_MS);
    });
    room.on(RoomEvent.ParticipantConnected, () => {
      if (agentWatchdogRef.current) {
        clearTimeout(agentWatchdogRef.current);
        agentWatchdogRef.current = null;
      }
    });
    room.on(RoomEvent.Reconnecting, () => setConnectionState("reconnecting"));
    room.on(RoomEvent.Reconnected, () => setConnectionState("connected"));
    room.on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
      if (reason !== undefined) {
        console.log("Room disconnected:", reason);
      }
      setConnectionState((s) =>
        s === "error" || s === "ended" ? s : "ended",
      );
      if (feedbackAttemptedRef.current) return;
      void runFeedbackFlow();
    });

    room.on(
      RoomEvent.TrackSubscribed,
      (
        track: RemoteTrack,
        _pub: RemoteTrackPublication,
        _p: RemoteParticipant,
      ) => {
        if (track.kind === Track.Kind.Audio && audioElRef.current) {
          track.attach(audioElRef.current);
        }
      },
    );

    room.on(RoomEvent.DataReceived, (payload: Uint8Array) => {
      let msg: AnyRoomMessage;
      try {
        msg = JSON.parse(new TextDecoder().decode(payload)) as AnyRoomMessage;
      } catch {
        return;
      }
      if (msg.type === "turn") {
        setTurns((prev) => [...prev, msg.payload]);
      } else if (msg.type === "status") {
        if (msg.payload.state === "agent_speaking") setAgentSpeaking(true);
        else if (msg.payload.state === "user_speaking") setAgentSpeaking(false);
      }
    });

    try {
      await room.connect(result.connection.wsUrl, result.connection.token);
      await room.localParticipant.setMicrophoneEnabled(true);
    } catch (err) {
      console.error("Room connect failed:", err);
      setConnectionState("error");
      setErrorMessage(err instanceof Error ? err.message : "Connection failed.");
      feedbackAttemptedRef.current = true;
    }
  }

  async function toggleMic() {
    const next = !micEnabled;
    setMicEnabled(next);
    try {
      await roomRef.current?.localParticipant.setMicrophoneEnabled(next);
    } catch (err) {
      console.error("Failed to toggle mic:", err);
      setMicEnabled(!next);
    }
  }

  async function endCall() {
    if (agentWatchdogRef.current) {
      clearTimeout(agentWatchdogRef.current);
      agentWatchdogRef.current = null;
    }
    const room = roomRef.current;
    if (room) {
      await room.disconnect();
      roomRef.current = null;
    }
    setConnectionState("ended");
    await runFeedbackFlow();
  }

  useEffect(() => {
    return () => {
      if (agentWatchdogRef.current) {
        clearTimeout(agentWatchdogRef.current);
      }
      roomRef.current?.disconnect();
    };
  }, []);

  const isLive =
    connectionState === "connected" || connectionState === "reconnecting";
  const isPreCall =
    connectionState === "idle" ||
    connectionState === "ended" ||
    connectionState === "error" ||
    connectionState === "connecting";

  // Audio sink mounted unconditionally so the track ref stays stable.
  const audioSink = (
    <audio ref={audioElRef} autoPlay playsInline className="hidden" />
  );

  if (isPreCall) {
    return (
      <>
        {audioSink}
        <PreCallReadyScreen
          starting={connectionState === "connecting"}
          retry={connectionState === "ended" || connectionState === "error"}
          errorMessage={errorMessage}
          onStart={startCall}
        />
      </>
    );
  }

  // ---------------------------------------------------------------------
  // In-call view — Google Meet clone (full-viewport takeover).
  //
  // - Pure black canvas; no glow, no dot grid (the dashboard has those).
  // - Two equal tiles fill the available area, sharp rounded corners.
  // - Bottom-center floating control bar: small circular buttons, red
  //   pill End separated by a divider.
  // - Top-right tiny chips for participant count + mic-off indicator.
  // - Bottom-left small meta (time + duration).
  // - Speaking cue is a hairline ring on the tile, no pulse animation.
  // - No nav, no breadcrumb during the call — the room is the screen.
  // ---------------------------------------------------------------------
  return (
    <div className="fixed inset-0 z-40 bg-black">
      {audioSink}

      {/* Tiles area */}
      <div className="absolute inset-0 grid grid-cols-1 md:grid-cols-2 gap-2 p-2 pb-24 md:p-3 md:pb-28">
        <ParticipantTile
          variant="agent"
          name="AI Interviewer"
          speaking={agentSpeaking && isLive}
        />
        <ParticipantTile
          variant="user"
          name={userName}
          speaking={!agentSpeaking && isLive && micEnabled}
          muted={!micEnabled}
        />
      </div>

      {/* Top-right: participant count + mic-off indicator (Meet style) */}
      <div className="absolute top-4 right-4 flex flex-col items-end gap-2 z-10">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 backdrop-blur-sm px-2.5 py-1 text-xs font-medium text-white">
          <Users className="size-3.5" />
          2
        </span>
        {!micEnabled && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-red-500/90 px-2 py-1 text-xs font-medium text-white">
            <MicOff className="size-3.5" />
          </span>
        )}
        {connectionState === "reconnecting" && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/90 px-2.5 py-1 text-xs font-medium text-white">
            Reconnecting…
          </span>
        )}
      </div>

      {/* Bottom-left: time + meta. Plain text, no pill. */}
      <div className="absolute bottom-7 left-6 flex items-center gap-3 text-[13px] text-white/70 z-10 max-md:hidden">
        <span className="tabular-nums">{formatClock(now)}</span>
        <span className="text-white/40" aria-hidden>
          |
        </span>
        <span className="font-mono tabular-nums">
          {formatDuration(elapsedMs)}
        </span>
      </div>

      {/* Bottom-center: control bar. Circle buttons + red pill End. */}
      <div className="absolute bottom-5 left-1/2 -translate-x-1/2 flex items-center gap-2 z-10">
        <CircleControl
          label={micEnabled ? "Mute microphone" : "Unmute microphone"}
          onClick={toggleMic}
          active={!micEnabled}
        >
          {micEnabled ? (
            <Mic className="size-5" />
          ) : (
            <MicOff className="size-5" />
          )}
        </CircleControl>

        {/* Spacer between mic and the destructive End. Mirrors Meet's
            grouping where End is visually separate from the per-feature
            toggles. */}
        <div className="w-2" />

        <button
          type="button"
          onClick={endCall}
          aria-label="End interview"
          className={cn(
            "inline-flex items-center justify-center h-12 px-6 rounded-full",
            "bg-red-500 hover:bg-red-600 text-white",
            "transition-colors active:scale-[0.97]",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2 focus-visible:ring-offset-black",
          )}
        >
          <PhoneOff className="size-5" />
        </button>
      </div>

      {errorMessage && (
        <div className="absolute bottom-24 left-1/2 -translate-x-1/2 z-10">
          <div className="inline-flex items-start gap-2 max-w-md rounded-lg bg-red-500/15 border border-red-500/30 backdrop-blur-sm px-3 py-2 text-sm text-red-200">
            <Info className="size-4 mt-0.5 flex-shrink-0" />
            <span>{errorMessage}</span>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Sub-components
 * ------------------------------------------------------------------------- */

function ParticipantTile({
  variant,
  name,
  speaking,
  muted,
}: {
  variant: "agent" | "user";
  name: string;
  speaking: boolean;
  muted?: boolean;
}) {
  return (
    <div
      className={cn(
        "relative w-full h-full overflow-hidden",
        "bg-neutral-900 rounded-2xl",
        "ring-1 transition-[box-shadow,_background-color] duration-150",
        speaking
          ? "ring-2 ring-blue-500 ring-offset-0"
          : "ring-white/[0.04]",
      )}
    >
      {/* Centered avatar — Meet's "video off" treatment */}
      <div className="absolute inset-0 flex items-center justify-center">
        {variant === "agent" ? (
          <AgentAvatar speaking={speaking} />
        ) : (
          <UserAvatar />
        )}
      </div>

      {/* Bottom-left name strip — small text, no pill, like Meet */}
      <div className="absolute bottom-3 left-4 flex items-center gap-2">
        {muted && (
          <span className="inline-flex items-center justify-center size-5 rounded-full bg-red-500">
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

function AgentAvatar({ speaking }: { speaking: boolean }) {
  return (
    <div
      className={cn(
        "flex items-center justify-center rounded-full transition-colors duration-200",
        // Sized relative to the tile via 18% of the smaller dimension
        // (clamped). Keeps the avatar visually significant on big tiles
        // and small tiles alike.
        "size-32 md:size-40 lg:size-48",
        speaking
          ? "bg-blue-500/90 text-white"
          : "bg-neutral-700 text-neutral-300",
      )}
    >
      <Bot className="size-1/2" strokeWidth={1.5} />
    </div>
  );
}

function UserAvatar() {
  return (
    <div className="flex items-center justify-center rounded-full overflow-hidden bg-neutral-700 size-32 md:size-40 lg:size-48">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/user-avatar.png"
        alt=""
        className="size-full object-cover"
      />
    </div>
  );
}

function CircleControl({
  label,
  onClick,
  active = false,
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={cn(
        "inline-flex items-center justify-center size-12 rounded-full transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-2 focus-visible:ring-offset-black",
        active
          ? "bg-red-500 text-white hover:bg-red-600"
          : "bg-white/10 text-white hover:bg-white/15",
      )}
    >
      {children}
    </button>
  );
}

function formatClock(d: Date): string {
  // Locale-aware short time: "11:14 AM" — matches the Meet bottom-left.
  return d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}
