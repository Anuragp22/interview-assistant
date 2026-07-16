import { NextRequest } from "next/server";

import { createPracticeSession } from "@/lib/actions/practice.action";
import {
  type Intensity,
  INTENSITY_LABELS,
  type PresetId,
  PRESETS,
} from "@/lib/presets";

export const runtime = "nodejs";
export const maxDuration = 60;

function parsePresetId(raw: unknown): PresetId | null {
  const v = String(raw ?? "");
  return v in PRESETS ? (v as PresetId) : null;
}

function parseIntensity(raw: unknown): Intensity | null {
  const v = String(raw ?? "");
  return v in INTENSITY_LABELS ? (v as Intensity) : null;
}

export async function POST(req: NextRequest) {
  const ct = req.headers.get("content-type") ?? "";

  let role: string;
  let level: "Junior" | "Mid" | "Senior" | "Staff";
  let jobDescription: string;
  let presetRaw: unknown;
  let intensityRaw: unknown;
  let newCv:
    | { buffer: ArrayBuffer; mimeType: string; filename: string }
    | undefined;

  if (ct.toLowerCase().includes("multipart/form-data")) {
    const form = await req.formData();
    role = String(form.get("role") ?? "");
    level =
      (form.get("level") as "Junior" | "Mid" | "Senior" | "Staff") ?? "Mid";
    jobDescription = String(form.get("jobDescription") ?? "");
    presetRaw = form.get("presetId");
    intensityRaw = form.get("intensity");

    const file = form.get("file");
    if (file instanceof File && file.size > 0) {
      newCv = {
        buffer: await file.arrayBuffer(),
        mimeType: file.type || "application/octet-stream",
        filename: file.name,
      };
    }
  } else if (ct.toLowerCase().includes("application/json")) {
    const body = await req.json();
    role = String(body.role ?? "");
    level = body.level ?? "Mid";
    jobDescription = String(body.jobDescription ?? "");
    presetRaw = body.presetId;
    intensityRaw = body.intensity;
  } else {
    return Response.json(
      {
        success: false,
        error: "Expected multipart/form-data or application/json",
      },
      { status: 400 },
    );
  }

  if (role.length < 2 || jobDescription.length < 80) {
    return Response.json(
      { success: false, error: "role and jobDescription are required" },
      { status: 400 },
    );
  }

  // Validate against the preset library rather than trusting the client —
  // the panel spec written to Firestore comes from PRESETS, keyed by this id.
  const presetId = parsePresetId(presetRaw);
  if (!presetId) {
    return Response.json(
      { success: false, error: "unknown presetId" },
      { status: 400 },
    );
  }
  const intensity =
    parseIntensity(intensityRaw) ?? PRESETS[presetId].defaultIntensity;

  const r = await createPracticeSession({
    role,
    level,
    jobDescription,
    presetId,
    intensity,
    newCv,
  });
  if (!r.success) {
    return Response.json({ success: false, error: r.message }, { status: 400 });
  }
  return Response.json(r);
}
