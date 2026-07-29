"use client";

import { useCallback, useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { AnimatePresence, LayoutGroup, motion } from "framer-motion";
import { ArrowLeft, ArrowRight, BookOpen, Github } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { REPO_URL } from "@/components/DocsLinks";
import { cn } from "@/lib/utils";
import {
  ABOUT,
  type AttackKey,
  type ControlKey,
  DOC_DRIFT,
  GLOSSARY,
  INTENSITY,
  INTENSITY_KEYS,
  type IntensityKey,
  type OutcomeKey,
  PRESET_KEYS,
  PRESETS,
  type PresetKey,
  STAGES,
} from "./content";
import { MECHANISMS } from "./mechanisms";

/* ------------------------------------------------------------------ *
 * Reference panel. Glossary first, because a newcomer meets an unknown
 * word before they want the preamble or the caveats.
 * ------------------------------------------------------------------ */

function ReferenceSheet() {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-1.5">
          <BookOpen className="size-4" />
          <span className="max-sm:sr-only">Glossary</span>
        </Button>
      </SheetTrigger>
      <SheetContent className="w-full sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Glossary and reference</SheetTitle>
          <p className="text-sm text-fg-muted">
            Every term this page uses, what the page is, and where it knowingly
            disagrees with the written docs.
          </p>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-6 pb-8">
          <section>
            <h3 className="mb-3 font-mono text-[10px] uppercase tracking-wider text-fg-subtle">
              {GLOSSARY.length} terms
            </h3>
            <dl className="grid gap-3">
              {GLOSSARY.map(([term, def]) => (
                <div key={term}>
                  <dt className="font-mono text-[12px] text-accent">{term}</dt>
                  <dd className="mt-0.5 text-[13px] leading-relaxed text-fg-muted">
                    {def}
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          <Separator className="my-5" />

          <section>
            <h3 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-fg-subtle">
              About this walkthrough
            </h3>
            {ABOUT.map((p) => (
              <p key={p} className="mb-2 text-[13px] leading-relaxed text-fg-muted">
                {p}
              </p>
            ))}
          </section>

          <Separator className="my-5" />

          <section>
            <h3 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-fg-subtle">
              Where this page and the docs disagree
            </h3>
            <p className="mb-2 text-[13px] leading-relaxed text-fg-muted">
              The code wins, and the difference is stated rather than smoothed
              over.
            </p>
            <ul className="grid list-none gap-2 pl-0">
              {DOC_DRIFT.map((d) => (
                <li
                  key={d}
                  className="rounded-md border border-amber-500/25 bg-amber-500/8 p-3 text-[12.5px] leading-relaxed text-fg-muted"
                >
                  {d}
                </li>
              ))}
            </ul>
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ *
 * Controls, scoped to the topic that reads them
 * ------------------------------------------------------------------ */

function ControlGroup({
  label,
  active,
  control,
  onPick,
  children,
}: {
  label: string;
  active: boolean;
  control: ControlKey;
  onPick: (i: number) => void;
  children: React.ReactNode;
}) {
  const readers = STAGES.map((s, i) => (s.uses.includes(control) ? i : -1)).filter(
    (i) => i >= 0,
  );

  return (
    <div
      // data-* so the DOM sweep can assert scoping without depending on classes
      data-control={control}
      data-active={active}
      className={cn(
        "flex items-center gap-2 transition-opacity",
        active ? "opacity-100" : "opacity-45 hover:opacity-90",
      )}
    >
      <span className="font-mono text-[10px] uppercase tracking-wider text-fg-subtle">
        {label}
      </span>
      {children}
      {!active ? (
        <span className="whitespace-nowrap font-mono text-[10px] text-fg-subtle">
          read by{" "}
          {readers.map((i, n) => (
            <span key={i}>
              {n > 0 ? " · " : ""}
              <button
                type="button"
                onClick={() => onPick(i)}
                className="underline underline-offset-2 hover:text-accent"
              >
                {String(i + 1).padStart(2, "0")}
              </button>
            </span>
          ))}
        </span>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */

export default function Walkthrough() {
  const [idx, setIdx] = useState(0);
  const [intensity, setIntensity] = useState<IntensityKey>("standard");
  const [preset, setPreset] = useState<PresetKey>("big-tech-swe");
  const [attack, setAttack] = useState<AttackKey>("tag");
  const [outcome, setOutcome] = useState<OutcomeKey>("pass");

  const stage = STAGES[idx];
  const Mechanism = MECHANISMS[stage.id];
  const isArch = Boolean(stage.full);

  /** Jump to a topic by id. Used by the architecture page blocks. */
  const nav = useCallback((stageId: string) => {
    const i = STAGES.findIndex((s) => s.id === stageId);
    if (i >= 0) setIdx(i);
  }, []);

  const mechProps = useMemo(
    () => ({ intensity, preset, attack, setAttack, outcome, setOutcome, nav }),
    [intensity, preset, attack, outcome, nav],
  );

  const uses = stage.uses;

  const why = (
    <>
      {stage.why.map((p, i) => (
        <p key={i} className="mb-3 text-[13.5px] leading-relaxed text-fg-muted">
          {p}
        </p>
      ))}

      <div className="mt-4 rounded-md border border-amber-500/25 bg-amber-500/8 p-3">
        <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-amber-300">
          The honest limitation
        </div>
        <p className="text-[13px] leading-relaxed text-fg-muted">{stage.limit}</p>
      </div>

      <div className="mt-4 flex flex-wrap gap-1.5">
        {stage.refs.map((r) => (
          <Badge key={r} mono variant="outline" className="max-w-full">
            <span className="truncate">{r}</span>
          </Badge>
        ))}
      </div>
    </>
  );

  return (
    <div className="min-h-screen bg-surface-0">
      {/* Compact header. No act tabs: eleven topics live in one rail. */}
      <header className="sticky top-0 z-40 border-b border-border-subtle bg-surface-0/90 backdrop-blur">
        <div className="mx-auto flex h-13 max-w-[1500px] items-center gap-3 px-4 py-2 sm:px-6">
          <Link href="/" className="flex shrink-0 items-center gap-2">
            <Image src="/logo.svg" alt="" width={24} height={20} />
            <span className="text-sm font-semibold tracking-tight text-fg-strong">
              JobVoice
            </span>
          </Link>

          <Separator orientation="vertical" className="h-5 max-sm:hidden" />

          {/* The route's only h1. Without it the page has no heading outline:
              every topic title is an h3 inside a Card. It sits on the text
              already in the header rather than a hero, which an earlier
              version had and dropped for pushing content below the fold.
              font-normal and tracking-normal undo the bare-h1 base rule in
              globals.css so this renders exactly as the span it replaced. */}
          <h1 className="min-w-0 flex-1 truncate text-[13px] font-normal tracking-normal text-fg-muted">
            <span className="font-mono text-[11px] text-fg-subtle">
              {String(idx + 1).padStart(2, "0")}/
              {String(STAGES.length).padStart(2, "0")}
            </span>{" "}
            <span className="text-fg-strong">{stage.rail}</span>
          </h1>

          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className={cn("gap-1.5", isArch && "text-accent")}
              onClick={() => setIdx(0)}
            >
              <span className="max-sm:sr-only">Architecture</span>
              <span className="sm:hidden">Arch</span>
            </Button>
            <ReferenceSheet />
            <Button variant="ghost" size="icon" asChild>
              <a
                href={REPO_URL}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Source on GitHub (opens in a new tab)"
              >
                <Github className="size-4" />
              </a>
            </Button>
          </div>
        </div>
      </header>

      <main
        className={cn(
          "mx-auto max-w-[1500px] px-4 sm:px-6",
          // The architecture page is budgeted to exactly one viewport, so it
          // cannot carry the usual bottom padding.
          isArch ? "pb-4" : "pb-16",
        )}
      >
        {/* Controls, only when some topic reads them. */}
        {uses.length > 0 || !isArch ? (
          <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2 border-b border-border-subtle py-2.5">
            <ControlGroup
              label="intensity"
              active={uses.includes("intensity")}
              control="intensity"
              onPick={setIdx}
            >
              <ToggleGroup
                type="single"
                value={intensity}
                onValueChange={(v) => v && setIntensity(v as IntensityKey)}
              >
                {INTENSITY_KEYS.map((k) => (
                  <ToggleGroupItem key={k} value={k}>
                    {INTENSITY[k].label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </ControlGroup>

            <ControlGroup
              label="preset"
              active={uses.includes("preset")}
              control="preset"
              onPick={setIdx}
            >
              <ToggleGroup
                type="single"
                value={preset}
                onValueChange={(v) => v && setPreset(v as PresetKey)}
              >
                {PRESET_KEYS.map((k) => (
                  <ToggleGroupItem key={k} value={k}>
                    {PRESETS[k].title}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </ControlGroup>
          </div>
        ) : null}

        <div className="grid gap-6 pt-4 lg:grid-cols-[212px_minmax(0,1fr)]">
          {/* min-w-0: a grid item defaults to min-width:auto, so without this
              the rail's intrinsic width (~980px) inflates the whole page below
              lg and body's overflow-x:hidden clips it. The ul's own
              overflow-x-auto only takes effect once the nav can shrink. */}
          <nav className="min-w-0 lg:sticky lg:top-[68px] lg:self-start">
            <p className="mb-2 px-2 font-mono text-[10px] uppercase tracking-wider text-fg-subtle">
              {STAGES.length} topics
            </p>
            <LayoutGroup id="rail">
              {/* list-none explicitly: globals.css re-adds a marker to bare ul */}
              <ul className="flex list-none gap-1 overflow-x-auto pb-1 pl-0 lg:flex-col lg:overflow-visible lg:pb-0">
                {STAGES.map((s, i) => (
                  <li key={s.id} className="shrink-0 lg:shrink">
                    <button
                      type="button"
                      onClick={() => setIdx(i)}
                      className={cn(
                        "relative flex w-full items-start gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors",
                        i === idx
                          ? "text-fg-strong"
                          : "text-fg-muted hover:text-fg-default",
                        i === 0 && "font-medium",
                      )}
                    >
                      {i === idx ? (
                        <motion.span
                          layoutId="rail-marker"
                          className="absolute inset-0 rounded-md bg-accent-soft ring-1 ring-accent-border"
                          transition={{ type: "spring", stiffness: 420, damping: 36 }}
                        />
                      ) : null}
                      <span
                        className={cn(
                          "relative font-mono text-[10px] leading-5",
                          i === idx ? "text-accent" : "text-fg-subtle",
                        )}
                      >
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      <span className="relative leading-5">{s.rail}</span>
                    </button>
                    {i === 0 ? (
                      <div className="my-1.5 h-px bg-border-subtle max-lg:hidden" />
                    ) : null}
                  </li>
                ))}
              </ul>
            </LayoutGroup>
          </nav>

          <div className="min-w-0">
            <AnimatePresence mode="wait">
              <motion.div
                key={stage.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.22 }}
                className={cn(
                  "grid items-start gap-5",
                  // The architecture page is full width. Everything else splits.
                  isArch ? "" : "xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]",
                )}
              >
                <Card
                  data-mech={stage.id}
                  className={cn(
                    "min-w-0",
                    // Sized to exactly one viewport so the map never scrolls.
                    // 140px = header 52 + top padding 16 + nav row 52 + slack.
                    isArch && "flex h-[calc(100dvh-140px)] min-h-[420px] flex-col",
                  )}
                >
                  <CardHeader className={cn(isArch && "shrink-0 pb-3")}>
                    <CardTitle className={cn(isArch && "text-xl")}>
                      {stage.title}
                    </CardTitle>
                    <p className="text-[13px] text-fg-muted">{stage.kicker}</p>
                  </CardHeader>
                  <CardContent className={cn(isArch && "min-h-0 flex-1")}>
                    <Mechanism {...mechProps} />
                  </CardContent>
                </Card>

                {/* Hidden on the architecture page: its reasoning lives in the
                    side panel there, and a second card would force a scroll. */}
                {isArch ? null : (
                  <Card data-why={stage.id} className="min-w-0">
                    <CardHeader>
                      <CardTitle className="font-mono text-[10px] uppercase tracking-wider text-fg-subtle">
                        Why it is built this way
                      </CardTitle>
                    </CardHeader>
                    <CardContent>{why}</CardContent>
                  </Card>
                )}
              </motion.div>
            </AnimatePresence>

            <div className="mt-5 flex items-center justify-between">
              <Button
                variant="ghost"
                size="sm"
                disabled={idx === 0}
                onClick={() => setIdx(Math.max(0, idx - 1))}
              >
                <ArrowLeft className="size-4" /> Previous
              </Button>
              <span className="font-mono text-[11px] text-fg-subtle">
                {String(idx + 1).padStart(2, "0")} /{" "}
                {String(STAGES.length).padStart(2, "0")}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={idx >= STAGES.length - 1}
                onClick={() => setIdx(Math.min(STAGES.length - 1, idx + 1))}
              >
                Next <ArrowRight className="size-4" />
              </Button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
