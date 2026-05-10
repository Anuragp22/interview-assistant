import { NextRequest } from "next/server";
import {
  uploadAndGroundCv,
  pasteAndGroundCv,
} from "@/lib/actions/sessions.action";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const ct = req.headers.get("content-type") ?? "";

  if (ct.startsWith("application/json")) {
    // Paste-text fallback path
    const body = await req.json();
    const r = await pasteAndGroundCv({ sessionId: id, cvText: body.cvText });
    if (!r.success) {
      return Response.json(
        { success: false, error: r.message },
        { status: 400 },
      );
    }
    return Response.json({ success: true, ...r.data });
  }

  // Multipart file upload path
  const form = await req.formData();
  const file = form.get("file") as File | null;
  if (!file) {
    return Response.json(
      { success: false, error: "No file provided" },
      { status: 400 },
    );
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  const r = await uploadAndGroundCv({
    sessionId: id,
    fileName: file.name,
    mimeType: file.type,
    buffer,
  });
  if (!r.success) {
    return Response.json({ success: false, error: r.message }, { status: 400 });
  }
  return Response.json({ success: true, ...r.data });
}
