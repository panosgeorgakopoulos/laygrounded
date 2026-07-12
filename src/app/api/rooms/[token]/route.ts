import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { loadRoomView, resolveShare } from "@/lib/rooms";
import { apiError } from "@/lib/api-errors";

// Public (token-authenticated) view of a claim room: the shared negotiation
// state both sides look at. Everything is scoped to the claim the validated
// share grants; guests never pass a claim id.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params;
    const supabase = createServiceRoleClient();
    const resolved = await resolveShare(token, supabase);
    if (!resolved) {
      return NextResponse.json({ error: "ROOM_NOT_FOUND" }, { status: 404 });
    }
    const view = await loadRoomView(resolved, supabase);
    return NextResponse.json(view);
  } catch (e) {
    return apiError(e, "rooms/GET", { ROOM_NOT_FOUND: 404 });
  }
}
