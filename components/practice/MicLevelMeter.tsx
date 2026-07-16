"use client";

import { useEffect, useRef, useState } from "react";
import { Mic, MicOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Live microphone level meter using the Web Audio API.
 *
 * Lets the user verify their mic works *before* the call starts — anyone
 * who's been on a Zoom call where their mic was silent the whole time
 * knows why this matters. Self-contained: spins up its own MediaStream,
 * tears down completely on stop or unmount, and never holds the mic open
 * once disabled.
 */
export default function MicLevelMeter() {
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState(0); // 0..1
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function stop() {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    setActive(false);
    setLevel(0);
  }

  async function start() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // Use the standardised AudioContext where available; fall back to the
      // webkit-prefixed name for older Safari.
      const Ctor: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      const ctx = new Ctor();
      audioCtxRef.current = ctx;

      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      const data = new Uint8Array(analyser.frequencyBinCount);
      source.connect(analyser);

      const tick = () => {
        analyser.getByteTimeDomainData(data);
        // Compute RMS over the time-domain samples; 128 is silence (centred
        // PCM byte). Convert to a 0..1 amplitude that's stable enough to
        // drive a bar without jitter.
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / data.length);
        // Boost the visual range a bit so normal speaking shows roughly
        // 30-70% bar fill instead of looking flat.
        const visual = Math.min(1, rms * 4);
        setLevel(visual);
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();

      setActive(true);
    } catch (e) {
      const message =
        e instanceof Error ? e.message : "Couldn't access the microphone.";
      // Most common: NotAllowedError (permission denied) or NotFoundError
      // (no mic). Surface a friendly hint either way.
      setError(
        e instanceof DOMException && e.name === "NotAllowedError"
          ? "Microphone permission was denied. Allow it in your browser and try again."
          : message,
      );
      stop();
    }
  }

  const pct = Math.round(level * 100);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <span className="inline-flex items-center gap-2 text-sm text-fg-default">
          <Mic className="size-4 text-accent" />
          Microphone
        </span>
        {active ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={stop}
            className="gap-2"
          >
            <MicOff className="size-3.5" />
            Stop test
          </Button>
        ) : (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={start}
            className="gap-2"
          >
            <Mic className="size-3.5" />
            Test mic
          </Button>
        )}
      </div>

      {/* Level meter — eight segments. Pure CSS, no extra deps. */}
      <div className="flex items-center gap-1 h-3">
        {Array.from({ length: 16 }).map((_, i) => {
          const segPct = (i + 1) * (100 / 16);
          const lit = pct >= segPct;
          // Color the last few segments red (clipping warning).
          const isWarn = i >= 13;
          return (
            <span
              key={i}
              className={cn(
                "h-full flex-1 rounded-sm transition-colors duration-75",
                lit
                  ? isWarn
                    ? "bg-destructive-100"
                    : "bg-accent"
                  : "bg-surface-2",
              )}
            />
          );
        })}
      </div>

      {error ? (
        <p className="text-xs text-destructive-100">{error}</p>
      ) : active ? (
        <p className="text-xs text-fg-muted">
          Speak normally. Bars should bounce in the green range.
        </p>
      ) : (
        <p className="text-xs text-fg-muted">
          Click <span className="text-fg-default">Test mic</span> to verify
          your microphone before starting.
        </p>
      )}
    </div>
  );
}
