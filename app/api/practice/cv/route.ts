import { NextRequest } from "next/server";

import { replaceCv, removeCv } from "@/lib/actions/practice.action";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const ct = req.headers.get("content-type") ?? "";
  if (!ct.toLowerCase().includes("multipart/form-data")) {
    return Response.json(
      { success: false, error: "Expected multipart/form-data" },
      { status: 400 },
    );
  }

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return Response.json(
      { success: false, error: "Missing 'file' field" },
      { status: 400 },
    );
  }

  const buffer = await file.arrayBuffer();
  const r = await replaceCv({
    buffer,
    mimeType: file.type || "application/octet-stream",
    filename: file.name,
  });
  if (!r.success) {
    return Response.json({ success: false, error: r.message }, { status: 400 });
  }
  return Response.json(r);
}

export async function DELETE(_req: NextRequest) {
  const r = await removeCv();
  if (!r.success) {
    return Response.json({ success: false, error: r.message }, { status: 400 });
  }
  return Response.json(r);
}
