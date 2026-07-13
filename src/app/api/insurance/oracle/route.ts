import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { hashApiKey } from "@/lib/insurance/oracle";
import { apiError } from "@/lib/api-errors";

// Read-only oracle endpoint for insurers. Authentication is the policy API
// key (Bearer), matched by hash — insurers have no Supabase session, so the
// read runs on the service role strictly scoped to the one policy the key
// unlocks. Unknown, paused, and malformed keys all get the same 401: the
// endpoint must not confirm which keys exist.
export async function GET(req: NextRequest) {
  try {
    const authz = req.headers.get("authorization") ?? "";
    const key = authz.startsWith("Bearer ") ? authz.slice(7).trim() : "";
    if (key.length < 16 || key.length > 128) {
      return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
    }

    const service = createServiceRoleClient();
    const { data: policy } = await service
      .from("insurance_policies")
      .select("id, insurer_label, threshold_hours, status")
      .eq("api_key_hash", hashApiKey(key))
      .eq("status", "active")
      .maybeSingle();
    if (!policy) {
      return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
    }

    const { data: triggers } = await service
      .from("insurance_triggers")
      .select(
        "id, trigger_type, delay_hours, window_start, window_end, threshold_hours, payload, delivery_status, delivered_at, created_at"
      )
      .eq("policy_id", policy.id)
      .order("created_at", { ascending: false })
      .limit(100);

    return NextResponse.json({
      policy: {
        id: policy.id,
        insurerLabel: policy.insurer_label,
        thresholdHours: policy.threshold_hours,
      },
      triggers: (triggers ?? []).map((t) => ({
        id: t.id,
        triggerType: t.trigger_type,
        delayHours: t.delay_hours,
        windowStart: t.window_start,
        windowEnd: t.window_end,
        thresholdHours: t.threshold_hours,
        payload: t.payload,
        deliveryStatus: t.delivery_status,
        deliveredAt: t.delivered_at,
        createdAt: t.created_at,
      })),
    });
  } catch (e) {
    return apiError(e, "insurance/oracle/GET");
  }
}
