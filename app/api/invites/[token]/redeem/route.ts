import { NextRequest } from "next/server";
import { redeemInvite } from "@/lib/actions/sessions.action";

export const runtime = "nodejs";

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
) {
  const { token } = await ctx.params;
  const r = await redeemInvite(token);
  if (!r.success) {
    return Response.json({ success: false, error: r.message }, { status: 400 });
  }
  return Response.json({ success: true, ...r.data });
}
