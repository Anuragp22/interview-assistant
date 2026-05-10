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
import { Bot, Mic, MicOff, PhoneOff } from "lucide-react";

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

  // Tick a duration counter while the call is connected. Scoped to "active
  // call" only — pauses on reconnecting, resets on a fresh call.
  useEffect(() => {
    if (connectionState !== "connected") return;
    const start = Date.now() - elapsedMs;
    const id = setInterval(() => setElapsedMs(Date.now() - start), 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionState]);

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
      // Roll back the optimistic state on failure so the UI reflects reality.
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

  // Audio sink is mounted unconditionally so the ref stays stable across
  // pre-call <-> in-call view switches.
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
  // In-call view — Google Meet pattern.
  // Two equal video-aspect tiles, the active speaker gets an accent ring
  // and breathing glow. Bottom control bar handles mic toggle + End.
  // No transcript on screen (you listen, you don't read), no question
  // counter (you don't pace yourself), no metadata header (you focus).
  // ---------------------------------------------------------------------
  return (
    <div className="flex flex-col gap-6">
      {audioSink}

      {/* Minimal status row: Live indicator + duration. Nothing else. */}
      <div className="flex items-center justify-between">
        <StatusChip state={connectionState} />
        {isLive && (
          <span className="font-mono text-sm text-fg-muted tabular-nums">
            {formatDuration(elapsedMs)}
          </span>
        )}
      </div>

      {/* Two-tile video grid. Equal sizes, 16:9 aspect ratio. */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <ParticipantTile
          variant="agent"
          name="AI Interviewer"
          subtitle={isLive ? (agentSpeaking ? "Speaking" : "Listening") : ""}
          speaking={agentSpeaking && isLive}
        />
        <ParticipantTile
          variant="user"
          name={userName}
          subtitle={
            isLive
              ? !micEnabled
                ? "Muted"
                : agentSpeaking
                  ? "Listening"
                  : "Speaking"
              : ""
          }
          speaking={!agentSpeaking && isLive && micEnabled}
          muted={!micEnabled}
        />
      </div>

      {/* Bottom control bar. Mic toggle + End. Settings live in the nav. */}
      <div className="flex flex-col items-center gap-3 mt-2">
        <div className="inline-flex items-center gap-2 p-1.5 rounded-full bg-surface-1 border border-border-default">
          <ControlButton
            label={micEnabled ? "Mute microphone" : "Unmute microphone"}
            onClick={toggleMic}
            tone={micEnabled ? "neutral" : "warning"}
          >
            {micEnabled ? (
              <Mic className="size-5" />
            ) : (
              <MicOff className="size-5" />
            )}
          </ControlButton>

          {/* Visual divider */}
          <span className="h-6 w-px bg-border-default" aria-hidden />

          <button
            type="button"
            onClick={endCall}
            aria-label="End interview"
            className={cn(
              "inline-flex items-center justify-center gap-2 h-11 px-5 rounded-full",
              "bg-destructive-200 text-white font-semibold text-sm",
              "transition-all hover:bg-destructive-100 active:scale-[0.97]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive-100 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-0",
              "shadow-[0_0_0_1px_oklch(0.66_0.22_25_/_30%)]",
            )}
          >
            <PhoneOff className="size-4" />
            End
          </button>
        </div>

        {errorMessage && (
          <p className="text-sm text-destructive-100 text-center max-w-md">
            {errorMessage}
          </p>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Sub-components
 * ------------------------------------------------------------------------- */

function ParticipantTile({
  variant,
  name,
  subtitle,
  speaking,
  muted,
}: {
  variant: "agent" | "user";
  name: string;
  subtitle: string;
  speaking: boolean;
  muted?: boolean;
}) {
  return (
    <div
      className={cn(
        "relative aspect-video rounded-xl overflow-hidden",
        "bg-surface-1 border transition-all duration-200",
        // Active-speaker ring + accent glow.
        speaking
          ? "border-accent shadow-[0_0_0_2px_var(--color-accent-soft),0_0_40px_-8px_var(--color-accent-soft)]"
          : "border-border-default",
      )}
    >
      {/* Subtle radial halo so the tile has depth */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            variant === "agent"
              ? "radial-gradient(ellipse 60% 80% at 50% 100%, var(--color-accent-soft), transparent)"
              : "radial-gradient(ellipse 60% 80% at 50% 100%, oklch(1 0 0 / 4%), transparent)",
        }}
      />

      {/* Centered avatar */}
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
        {variant === "agent" ? (
          <AgentAvatar speaking={speaking} />
        ) : (
          <UserAvatar muted={muted} />
        )}
      </div>

      {/* Name strip — bottom-left, like Google Meet */}
      <div className="absolute left-3 bottom-3 right-3 flex items-center justify-between gap-2">
        <span
          className={cn(
            "inline-flex items-center gap-2 px-2.5 py-1 rounded-md",
            "bg-surface-0/70 backdrop-blur-sm border border-border-default",
            "text-xs font-medium text-fg-strong max-w-full",
          )}
        >
          {muted && <MicOff className="size-3 text-destructive-100" />}
          <span className="truncate">{name}</span>
        </span>
        {subtitle && (
          <span
            className={cn(
              "inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium",
              "bg-surface-0/70 backdrop-blur-sm border border-border-default",
              speaking ? "text-fg-strong" : "text-fg-muted",
            )}
          >
            {speaking && (
              <span className="size-1.5 rounded-full bg-accent animate-pulse" />
            )}
            {subtitle}
          </span>
        )}
      </div>
    </div>
  );
}

function AgentAvatar({ speaking }: { speaking: boolean }) {
  return (
    <div className="relative">
      {/* Speaking pulse rings — only render when active so idle tile is clean */}
      {speaking && (
        <>
          <span className="absolute inset-0 rounded-full bg-accent/15 animate-ping" />
          <span
            className="absolute inset-0 rounded-full bg-accent/25 animate-ping"
            style={{ animationDelay: "0.4s" }}
          />
        </>
      )}
      <div
        className={cn(
          "relative flex items-center justify-center size-32 rounded-full",
          "transition-all duration-300",
          speaking
            ? "bg-gradient-to-br from-accent to-accent-hover shadow-[0_0_60px_-10px_var(--color-accent)]"
            : "bg-gradient-to-br from-surface-3 to-surface-2",
          "border border-border-strong",
        )}
      >
        <Bot
          className={cn(
            "size-16 transition-colors",
            speaking ? "text-accent-fg" : "text-fg-default",
          )}
          strokeWidth={1.5}
        />
      </div>
    </div>
  );
}

function UserAvatar({ muted }: { muted?: boolean }) {
  return (
    <div className="relative">
      <div
        className={cn(
          "relative flex items-center justify-center size-32 rounded-full overflow-hidden",
          "bg-surface-2 border border-border-strong",
          muted && "opacity-70",
        )}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/user-avatar.png"
          alt=""
          className="size-full object-cover"
        />
      </div>
    </div>
  );
}

function ControlButton({
  label,
  onClick,
  tone = "neutral",
  children,
}: {
  label: string;
  onClick: () => void;
  tone?: "neutral" | "warning";
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={cn(
        "inline-flex items-center justify-center size-11 rounded-full transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface-1",
        tone === "warning"
          ? "bg-destructive-100/15 border border-destructive-100/30 text-destructive-100 hover:bg-destructive-100/25"
          : "bg-surface-2 border border-border-default text-fg-default hover:bg-surface-3 hover:text-fg-strong",
      )}
    >
      {children}
    </button>
  );
}

function StatusChip({ state }: { state: ConnectionState }) {
  const config: Record<
    ConnectionState,
    { label: string; dotClass: string; textClass: string; bgClass: string }
  > = {
    idle: {
      label: "Ready",
      dotClass: "bg-fg-subtle",
      textClass: "text-fg-muted",
      bgClass: "bg-surface-2 border-border-default",
    },
    connecting: {
      label: "Connecting",
      dotClass: "bg-accent animate-pulse",
      textClass: "text-fg-strong",
      bgClass: "bg-accent-soft border-accent-border",
    },
    connected: {
      label: "Live",
      dotClass: "bg-success-100 animate-pulse",
      textClass: "text-fg-strong",
      bgClass: "bg-success-100/10 border-success-100/30",
    },
    reconnecting: {
      label: "Reconnecting",
      dotClass: "bg-accent animate-pulse",
      textClass: "text-fg-strong",
      bgClass: "bg-accent-soft border-accent-border",
    },
    ended: {
      label: "Ended",
      dotClass: "bg-fg-subtle",
      textClass: "text-fg-muted",
      bgClass: "bg-surface-2 border-border-default",
    },
    error: {
      label: "Error",
      dotClass: "bg-destructive-100",
      textClass: "text-destructive-100",
      bgClass: "bg-destructive-100/10 border-destructive-100/30",
    },
  };
  const c = config[state];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 px-3 py-1 rounded-full border text-xs font-medium",
        c.bgClass,
        c.textClass,
      )}
    >
      <span className={cn("size-1.5 rounded-full", c.dotClass)} />
      {c.label}
    </span>
  );
}

function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}
