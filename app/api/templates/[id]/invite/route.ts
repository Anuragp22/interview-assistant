import { NextRequest } from "next/server";
import { mintInviteToken } from "@/lib/actions/templates.action";

export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  const r = await mintInviteToken(id, body.candidateEmail);
  if (!r.success) {
    return Response.json({ success: false, error: r.message }, { status: 500 });
  }
  return Response.json({ success: true, ...r.data });
}
