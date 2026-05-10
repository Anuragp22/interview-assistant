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
import { PhoneOff, User } from "lucide-react";

import { mintInterviewRoomToken } from "@/lib/actions/interview.action";
import { createFeedback } from "@/lib/actions/general.action";
import { cn } from "@/lib/utils";
import PreCallReadyScreen from "./PreCallReadyScreen";

// If the AI agent worker isn't running (or is misconfigured), the LiveKit
// room connect still succeeds — the browser just sits in "Connected" with
// no remote participant ever joining. 10s is comfortably above the cold-
// start window for the Python agent dispatcher under normal conditions
// while still being short enough that the user gets actionable feedback
// instead of a silent stall.
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
  // Briefing data shown on the pre-call ready screen.
  questions: string[];
  type: string;
  role: string;
};

type Turn = { role: "user" | "assistant"; content: string; index: number };

export default function RoomClient({
  interviewId,
  userId,
  userName,
  feedbackId,
  questions,
  type,
  role,
}: Props) {
  const router = useRouter();
  const roomRef = useRef<Room | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const agentWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latches once we either start a feedback request or decide not to (e.g. the
  // watchdog tripped). Both endCall() and the Disconnected event handler check
  // this so the feedback flow can never run twice for the same session.
  const feedbackAttemptedRef = useRef(false);

  const [connectionState, setConnectionState] =
    useState<ConnectionState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [agentSpeaking, setAgentSpeaking] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);

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
    // Idempotent: only the first caller (endCall, Disconnected handler, etc.)
    // wins. Subsequent calls bail out so we never double-fire createFeedback.
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
      // Surface why we're bouncing the user back to the dashboard instead of
      // the feedback page. Common cause: no turns persisted (agent crashed,
      // or call ended before any conversation happened) — see createFeedback
      // in lib/actions/general.action.ts.
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
    // New session → clear the latch so a fresh feedback attempt can run.
    feedbackAttemptedRef.current = false;

    const result = await mintInterviewRoomToken(interviewId);
    if (!result.success) {
      setConnectionState("error");
      setErrorMessage(result.message);
      // Token mint failed → no room → no possible feedback. Latch so a
      // later cleanup-disconnect doesn't spuriously call createFeedback.
      feedbackAttemptedRef.current = true;
      return;
    }

    const room = new Room({ adaptiveStream: true, dynacast: true });
    roomRef.current = room;

    room.on(RoomEvent.Connected, () => {
      setConnectionState("connected");
      // Watchdog: if the AI agent doesn't join within AGENT_JOIN_TIMEOUT_MS,
      // surface an error. Without this, the user sees "Connected" forever
      // when the Python agent worker isn't running.
      agentWatchdogRef.current = setTimeout(() => {
        setConnectionState("error");
        setErrorMessage(
          "AI interviewer did not join. The interview-agent worker may not be running. " +
            "Try again in a moment or check the agent service logs.",
        );
        // No agent ever joined → no conversation → no feedback to generate.
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

  // Audio sink is mounted unconditionally at the top so the ref points to
  // the same DOM node across pre-call <-> in-call view switches. The
  // TrackSubscribed handler captures audioElRef.current at attach time,
  // so unmounting/remounting the audio element under it would silence
  // the agent.
  const audioSink = (
    <audio ref={audioElRef} autoPlay playsInline className="hidden" />
  );

  // Pre-call: ready screen with briefing + mic test. Also shown after the
  // call ends or errors so the user can retry without losing context.
  // 'connecting' falls in here too — the disabled "Connecting…" CTA on
  // the ready screen keeps the briefing visible during the brief connect
  // window instead of flashing an empty in-call view.
  if (isPreCall) {
    return (
      <>
        {audioSink}
        <PreCallReadyScreen
          role={role}
          type={type}
          questionsCount={questions.length}
          starting={connectionState === "connecting"}
          retry={connectionState === "ended" || connectionState === "error"}
          errorMessage={errorMessage}
          onStart={startCall}
        />
      </>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {audioSink}

      {/* Status bar: state chip + duration */}
      <div className="flex items-center justify-between">
        <StatusChip state={connectionState} />
        {isLive && (
          <span className="font-mono text-sm text-fg-muted tabular-nums">
            {formatDuration(elapsedMs)}
          </span>
        )}
      </div>

      {/* Centerpiece: the AI avatar dominates the screen so the user
          listens (no transcript to read). User self-view sits smaller
          alongside on desktop or below on mobile, like a Zoom self-view.
          We deliberately don't render the live transcript — reading the
          AI's text-as-it-arrives breaks the rhythm of a real interview.
          The full transcript lands on the feedback page after the call. */}
      <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-4 items-center">
        <ParticipantCard
          variant="agent"
          name="AI Interviewer"
          subtitle={
            isLive
              ? agentSpeaking
                ? "Speaking"
                : "Listening"
              : ""
          }
          imageSrc="/ai-avatar.png"
          imageAlt="AI Interviewer"
          speaking={agentSpeaking && isLive}
          isLive={isLive}
          size="large"
        />
        <ParticipantCard
          variant="user"
          name={userName}
          subtitle={isLive ? (agentSpeaking ? "Listening" : "Speaking") : ""}
          imageSrc="/user-avatar.png"
          imageAlt={userName}
          speaking={!agentSpeaking && isLive}
          isLive={isLive}
          size="small"
        />
      </div>

      {/* Call control — only End in-call. Start is on the pre-call ready
          screen, never reachable here. */}
      <div className="flex flex-col items-center gap-3 mt-2">
        <button
          type="button"
          onClick={endCall}
          className={cn(
            "inline-flex items-center justify-center gap-2 px-8 py-3.5 text-sm font-semibold",
            "rounded-full bg-destructive-200 text-white transition-all",
            "hover:bg-destructive-100 active:scale-[0.98]",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive-100 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-0",
            "shadow-[0_0_0_1px_oklch(0.66_0.22_25_/_30%),0_8px_24px_-8px_oklch(0.66_0.22_25_/_50%)]",
            "min-w-40",
          )}
        >
          <PhoneOff className="size-4" />
          End interview
        </button>

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

function ParticipantCard({
  variant,
  name,
  subtitle,
  imageSrc,
  imageAlt,
  speaking,
  isLive,
  size = "large",
}: {
  variant: "agent" | "user";
  name: string;
  subtitle: string;
  imageSrc: string;
  imageAlt: string;
  speaking: boolean;
  isLive: boolean;
  size?: "large" | "small";
}) {
  const isSmall = size === "small";
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-xl bg-surface-1 border border-border-default",
        "flex flex-col items-center justify-center",
        isSmall ? "gap-2.5 p-5 min-h-[200px] md:w-56" : "gap-5 p-10 min-h-[420px]",
        // Subtle accent halo on top — strongest for the agent card to anchor
        // visual attention; lighter for the user card.
        "before:absolute before:inset-0 before:pointer-events-none",
        variant === "agent"
          ? "before:bg-[radial-gradient(ellipse_70%_45%_at_50%_0%,var(--color-accent-soft),transparent)]"
          : "before:bg-[radial-gradient(ellipse_60%_35%_at_50%_0%,oklch(1_0_0_/_4%),transparent)]",
        // Speaking state amplifies the halo so it's obvious who's talking
        speaking && "ring-1 ring-accent",
      )}
    >
      <div className="relative z-10">
        {/* Pulse rings while speaking. Two rings staggered for a soft
            breathing effect rather than a single hard ping. */}
        {speaking && (
          <>
            <span className="absolute inset-0 rounded-full bg-accent/20 animate-ping" />
            <span
              className="absolute inset-0 rounded-full bg-accent/30 animate-ping"
              style={{ animationDelay: "0.4s" }}
            />
          </>
        )}
        <div
          className={cn(
            "relative flex items-center justify-center rounded-full overflow-hidden",
            "bg-surface-2 border transition-colors",
            isSmall ? "size-20" : "size-44",
            speaking
              ? "border-accent shadow-[0_0_0_4px_var(--color-accent-soft)]"
              : "border-border-strong",
          )}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={imageSrc}
            alt={imageAlt}
            className="size-full object-cover"
          />
        </div>
      </div>
      <div className="relative z-10 flex flex-col items-center gap-1">
        <h3
          className={cn(
            "font-semibold text-fg-strong",
            isSmall ? "text-sm" : "text-lg",
          )}
        >
          {name}
        </h3>
        {subtitle && (
          <p
            className={cn(
              "flex items-center gap-1.5 text-fg-muted",
              isSmall ? "text-[11px]" : "text-xs",
            )}
          >
            {speaking ? (
              <span className="size-1.5 rounded-full bg-accent animate-pulse" />
            ) : isLive && variant === "user" ? (
              <User className="size-3" />
            ) : null}
            {subtitle}
          </p>
        )}
      </div>
    </div>
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
