import { NextRequest } from "next/server";
import { createTemplate } from "@/lib/actions/templates.action";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const r = await createTemplate({
    title: body.title,
    role: body.role,
    level: body.level,
    jobDescription: body.jobDescription,
  });
  if (!r.success) {
    return Response.json({ success: false, error: r.message }, { status: 500 });
  }
  return Response.json({ success: true, templateId: r.data.templateId });
}
