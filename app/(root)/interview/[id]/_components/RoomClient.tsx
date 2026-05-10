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

import { mintInterviewRoomToken } from "@/lib/actions/interview.action";
import { createFeedback } from "@/lib/actions/general.action";
import { cn } from "@/lib/utils";

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
  // Latches once we either start a feedback request or decide not to (e.g. the
  // watchdog tripped). Both endCall() and the Disconnected event handler check
  // this so the feedback flow can never run twice for the same session.
  const feedbackAttemptedRef = useRef(false);

  const [connectionState, setConnectionState] = useState<ConnectionState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [agentSpeaking, setAgentSpeaking] = useState(false);

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
        // Latch so the upcoming Disconnected event doesn't spuriously fire
        // createFeedback (which would just hit Firestore, find zero turns,
        // toast a confusing failure on top of the watchdog error).
        feedbackAttemptedRef.current = true;
        // Disconnect so we stop publishing mic audio.
        roomRef.current?.disconnect();
      }, AGENT_JOIN_TIMEOUT_MS);
    });
    room.on(RoomEvent.ParticipantConnected, () => {
      // The agent (or any remote participant) joined — clear the watchdog.
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
      // Preserve "error" so the watchdog message keeps rendering; otherwise
      // mark the call ended.
      setConnectionState((s) =>
        s === "error" || s === "ended" ? s : "ended",
      );
      // Best-effort feedback generation when the room ends without the user
      // clicking "End" — covers server-side termination, network drops, and
      // unmount-on-route-change. Tab close is a "best-effort" only: the
      // server action gets fired but the redirect won't happen because the
      // page is already going away.
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
        return; // ignore malformed
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
      // Connect itself failed → no conversation possible. Latch so the
      // teardown disconnect doesn't fire feedback against an empty room.
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

  const lastAssistant =
    [...turns].reverse().find((t) => t.role === "assistant")?.content ?? "";

  return (
    <>
      <div className="call-view">
        <div className="card-interviewer">
          <div className="avatar">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/ai-avatar.png"
              alt="profile-image"
              width={65}
              height={54}
              className="object-cover"
            />
            {agentSpeaking && <span className="animate-speak" />}
          </div>
          <h3>AI Interviewer</h3>
        </div>
        <div className="card-border">
          <div className="card-content">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/user-avatar.png"
              alt="profile-image"
              width={539}
              height={539}
              className="rounded-full object-cover size-[120px]"
            />
            <h3>{userName}</h3>
          </div>
        </div>
      </div>

      {turns.length > 0 && (
        <div className="transcript-border">
          <div className="transcript">
            <p
              key={lastAssistant}
              className={cn(
                "transition-opacity duration-500",
                "animate-fadeIn opacity-100",
              )}
            >
              {lastAssistant}
            </p>
          </div>
        </div>
      )}

      <audio ref={audioElRef} autoPlay playsInline />

      <div className="w-full flex justify-center">
        {connectionState !== "connected" && connectionState !== "reconnecting" ? (
          <button
            className="relative btn-call"
            onClick={startCall}
            disabled={connectionState === "connecting"}
          >
            <span className="relative">
              {connectionState === "connecting" ? ". . ." : "Call"}
            </span>
          </button>
        ) : (
          <button className="btn-disconnect" onClick={endCall}>
            End
          </button>
        )}
      </div>

      {errorMessage && (
        <p className="text-red-400 text-sm text-center mt-2">{errorMessage}</p>
      )}
    </>
  );
}
