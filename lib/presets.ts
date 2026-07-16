/**
 * The preset library — the only panel configuration a user can pick.
 *
 * A preset fixes panel composition + rounds + rubrics; the user chooses
 * CONTEXT, never rubric content, which is what keeps the score meaningful
 * (you cannot grade your own homework). Adding a preset means AUTHORING
 * rubric anchors in lib/rubric.ts — deliberate friction.
 *
 * Voice ids deliberately reuse the three ids already verified against the
 * ElevenLabs account (see persona.py history): two presets never run in the
 * same session, so cross-preset voice reuse is unobservable, and it avoids
 * shipping an unverified id that 404s at synthesis time.
 */
import type { RoundId } from "@/lib/rubric";

export type PresetId = "big-tech-swe" | "startup-generalist" | "new-grad-swe";
export type Intensity = "calm" | "standard" | "grill";

export interface PanelPersonaDef {
  id: string;
  name: string;
  expertiseArea: string;
  voiceId: string;
  voiceSettings: {
    stability: number;
    similarityBoost: number;
    speed: number;
    style: number;
    useSpeakerBoost: boolean;
  };
}

export interface PresetRoundDef {
  roundId: RoundId;
  leadPersonaId: string;
  /** One-line brief handed to question generation for this round. */
  generationFocus: string;
}

export interface PanelPreset {
  id: PresetId;
  title: string;
  description: string;
  personas: PanelPersonaDef[];
  rounds: PresetRoundDef[];
  defaultIntensity: Intensity;
}

const VOICE_SARAH = "EXAVITQu4vr4xnSDxMaL";
const VOICE_ADAM = "pNInz6obpgDQGcFmaJgB";
const VOICE_BELLA = "hpp4J3VqNfWAUOO0d1Us";

const SETTINGS_WARM = {
  stability: 0.4,
  similarityBoost: 0.8,
  speed: 0.9,
  style: 0.5,
  useSpeakerBoost: true,
};
const SETTINGS_FIRM = {
  stability: 0.5,
  similarityBoost: 0.85,
  speed: 1.0,
  style: 0.3,
  useSpeakerBoost: true,
};
const SETTINGS_BRIGHT = {
  stability: 0.5,
  similarityBoost: 0.8,
  speed: 0.85,
  style: 0.4,
  useSpeakerBoost: true,
};

export const PRESETS: Record<PresetId, PanelPreset> = {
  "big-tech-swe": {
    id: "big-tech-swe",
    title: "Big-tech SWE loop",
    description:
      "The classic three-round panel: behavioral, technical depth, system design.",
    personas: [
      {
        id: "behavioral",
        name: "Sarah",
        expertiseArea:
          "behavioral interviewer specialising in STAR-framework probes",
        voiceId: VOICE_SARAH,
        voiceSettings: SETTINGS_WARM,
      },
      {
        id: "technical",
        name: "Adam",
        expertiseArea:
          "senior technical interviewer who probes implementation depth",
        voiceId: VOICE_ADAM,
        voiceSettings: SETTINGS_FIRM,
      },
      {
        id: "system-design",
        name: "Bella",
        expertiseArea:
          "senior systems engineer focused on distributed-systems design",
        voiceId: VOICE_BELLA,
        voiceSettings: SETTINGS_BRIGHT,
      },
    ],
    rounds: [
      {
        roundId: "behavioral",
        leadPersonaId: "behavioral",
        generationFocus:
          "STAR-method probes into real past experience — situations, actions, results.",
      },
      {
        roundId: "technical",
        leadPersonaId: "technical",
        generationFocus:
          "concrete implementation depth: data structures, complexity, code-level trade-offs.",
      },
      {
        roundId: "systemDesign",
        leadPersonaId: "system-design",
        generationFocus:
          "open-ended distributed-systems design with constraints, bottlenecks, trade-offs.",
      },
    ],
    defaultIntensity: "standard",
  },
  "startup-generalist": {
    id: "startup-generalist",
    title: "Early-startup generalist",
    description:
      "A founder and a senior engineer. Ownership, ambiguity, shipping — no system-design theatre.",
    personas: [
      {
        id: "founder",
        name: "Maya",
        expertiseArea:
          "startup founder who probes ownership, ambiguity tolerance, and bias to ship",
        voiceId: VOICE_SARAH,
        voiceSettings: SETTINGS_BRIGHT,
      },
      {
        id: "senior-eng",
        name: "Dev",
        expertiseArea:
          "pragmatic senior engineer who probes what the candidate actually built",
        voiceId: VOICE_ADAM,
        voiceSettings: SETTINGS_FIRM,
      },
    ],
    rounds: [
      {
        roundId: "ownership",
        leadPersonaId: "founder",
        generationFocus:
          "what the candidate personally owned, decided, and shipped when there was no playbook.",
      },
      {
        roundId: "technical",
        leadPersonaId: "senior-eng",
        generationFocus:
          "implementation reality of things on the CV: what broke, what they'd redo, why.",
      },
    ],
    defaultIntensity: "standard",
  },
  "new-grad-swe": {
    id: "new-grad-swe",
    title: "New-grad SWE",
    description:
      "Fundamentals and behavioral basics, calibrated for a thin CV — projects and coursework count.",
    personas: [
      {
        id: "behavioral",
        name: "Sarah",
        expertiseArea:
          "behavioral interviewer calibrated for early-career candidates",
        voiceId: VOICE_SARAH,
        voiceSettings: SETTINGS_WARM,
      },
      {
        id: "fundamentals",
        name: "Adam",
        expertiseArea:
          "engineer who probes computing fundamentals through walk-me-through questions",
        voiceId: VOICE_ADAM,
        voiceSettings: SETTINGS_FIRM,
      },
    ],
    rounds: [
      {
        roundId: "behavioral",
        leadPersonaId: "behavioral",
        generationFocus:
          "past-experience probes where coursework, internships, and projects count as experience.",
      },
      {
        roundId: "fundamentals",
        leadPersonaId: "fundamentals",
        generationFocus:
          "data structures, big-O intuition, and what actually happens at runtime — no trivia.",
      },
    ],
    defaultIntensity: "calm",
  },
};

export const PRESET_IDS = Object.keys(PRESETS) as PresetId[];

export const INTENSITY_LABELS: Record<
  Intensity,
  { label: string; blurb: string }
> = {
  calm: {
    label: "Calm",
    blurb: "One interviewer at a time. Patient follow-ups, no interruptions.",
  },
  standard: {
    label: "Standard",
    blurb:
      "The panel is present — expect the occasional pointed interjection.",
  },
  grill: {
    label: "Grill",
    blurb:
      "Deliberate pressure practice: interruptions, cross-examination, panelists who disagree. Meant to be hard.",
  },
};

export const INTENSITY_ORDER: Intensity[] = ["calm", "standard", "grill"];
