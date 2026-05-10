import { NextRequest } from "next/server";
import {
  getTemplate,
  updateTemplate,
} from "@/lib/actions/templates.action";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const t = await getTemplate(id);
  if (!t) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ template: t });
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const patch = await req.json();
  const r = await updateTemplate(id, patch);
  if (!r.success) {
    return Response.json({ success: false, error: r.message }, { status: 500 });
  }
  return Response.json({ success: true, ...r.data });
}
