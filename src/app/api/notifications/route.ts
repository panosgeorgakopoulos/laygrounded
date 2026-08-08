// The recipient's own inbox.
//
// COOKIE CLIENT, NOT SERVICE ROLE, and that is the whole security model here.
// `notifications` is the one table in this app whose SELECT policy is keyed on
// `auth.uid()` rather than on company membership — a notification is personal,
// and an admin has no business reading a colleague's inbox. Reaching for the
// service-role client here, as most routes in this codebase do, would quietly
// hand every caller everyone else's alerts.
//
// The explicit `.eq("user_id", auth.userId)` filters are defence in depth on
// top of that policy, matching the pattern every claim-scoped route uses.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import { apiError } from "@/lib/api-errors";

const COLUMNS =
  "id, kind, severity, title, body, href, subject_type, subject_id, read_at, dismissed_at, created_at";

const MutateSchema = z
  .object({
    action: z.enum(["read", "unread", "dismiss"]),
    ids: z.array(z.string().uuid()).max(200).optional(),
    /** Applies to everything currently outstanding for this user. */
    all: z.boolean().optional(),
  })
  .refine((v) => (v.ids && v.ids.length > 0) || v.all, {
    message: "Pass ids or all",
  });

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth();
    const supabase = await createClient();

    const url = new URL(req.url);
    const includeDismissed = url.searchParams.get("include") === "all";
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 30, 1), 100);

    let q = supabase
      .from("notifications")
      .select(COLUMNS)
      .eq("user_id", auth.userId)
      .order("created_at", { ascending: false })
      .limit(limit);

    // Dismissed rows are hidden by default but never deleted — see the table
    // comment. "Nobody warned me" and "I dismissed the warning" must stay
    // distinguishable after the fact.
    if (!includeDismissed) q = q.is("dismissed_at", null);

    const { data, error } = await q;
    if (error) throw new Error(`NOTIFICATIONS_READ_FAILED: ${error.message}`);

    // Counted separately rather than derived from the page above: the badge
    // must be right even when there are more unread items than fit in one page,
    // and "30+" dressed up as "30" is a number people stop trusting.
    const { count, error: countErr } = await supabase
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("user_id", auth.userId)
      .is("read_at", null)
      .is("dismissed_at", null);
    if (countErr) throw new Error(`NOTIFICATIONS_COUNT_FAILED: ${countErr.message}`);

    return NextResponse.json({
      notifications: (data ?? []).map((n) => ({
        id: n.id,
        kind: n.kind,
        severity: n.severity,
        title: n.title,
        body: n.body,
        href: n.href,
        subjectType: n.subject_type,
        subjectId: n.subject_id,
        readAt: n.read_at,
        dismissedAt: n.dismissed_at,
        createdAt: n.created_at,
      })),
      unreadCount: count ?? 0,
    });
  } catch (e) {
    return apiError(e, "notifications/GET");
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const auth = await requireAuth();
    const supabase = await createClient();

    const parsed = MutateSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const now = new Date().toISOString();
    // Only these two columns are writable at all: the migration revokes UPDATE
    // on the table and re-grants it column-wise, so a request that tried to
    // rewrite a title would be refused by Postgres rather than by this route.
    const patch =
      parsed.data.action === "read"
        ? { read_at: now }
        : parsed.data.action === "unread"
          ? { read_at: null }
          : { dismissed_at: now, read_at: now };

    let q = supabase.from("notifications").update(patch).eq("user_id", auth.userId);

    if (parsed.data.ids?.length) {
      q = q.in("id", parsed.data.ids);
    } else {
      // "Mark all read" means what is currently outstanding, not what is
      // outstanding when the statement runs — but PostgREST has no snapshot to
      // offer, so the honest scope is "everything not yet dismissed".
      q = q.is("dismissed_at", null);
      if (parsed.data.action === "read") q = q.is("read_at", null);
    }

    const { data, error } = await q.select("id");
    if (error) throw new Error(`NOTIFICATIONS_UPDATE_FAILED: ${error.message}`);

    return NextResponse.json({ updated: data?.length ?? 0 });
  } catch (e) {
    return apiError(e, "notifications/PATCH");
  }
}
