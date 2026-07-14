import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { loadRoomView, resolveShare } from "@/lib/rooms";
import { apiError } from "@/lib/api-errors";

// Public (token-authenticated) view of a claim room: the shared negotiation
// state both sides look at. Everything is scoped to the claim the validated
// share grants; guests never pass a claim id.
//
// ?proposals=<id,id,…> narrows the redline diff to that subset of pending
// proposals — the room UI's live what-if toggles. An empty value means "no
// proposals applied" (baseline vs baseline); ids the guest can see anyway,
// so the filter grants nothing new.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params;
    const supabase = createServiceRoleClient();
    const resolved = await resolveShare(token, supabase);
    if (!resolved) {
      return NextResponse.json({ error: "ROOM_NOT_FOUND" }, { status: 404 });
    }
    const proposalsParam = req.nextUrl.searchParams.get("proposals");
    const proposalFilter =
      proposalsParam === null
        ? undefined
        : proposalsParam.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 200);
    const view = await loadRoomView(resolved, supabase, { proposalFilter });
    return NextResponse.json(view);
  } catch (e) {
    return apiError(e, "rooms/GET", { ROOM_NOT_FOUND: 404 });
  }
}
