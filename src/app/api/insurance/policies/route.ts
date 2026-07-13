import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { randomBytes } from "crypto";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import { generateInsurerApiKey, hashApiKey, DEFAULT_THRESHOLD_HOURS } from "@/lib/insurance/oracle";
import { apiError } from "@/lib/api-errors";

const CreatePolicySchema = z.object({
  insurerLabel: z.string().min(1).max(200),
  webhookUrl: z.url().optional(),
  thresholdHours: z.number().positive().default(DEFAULT_THRESHOLD_HOURS),
});

function serialize(p: any) {
  // api_key_hash and webhook_secret never leave the server.
  return {
    id: p.id,
    insurerLabel: p.insurer_label,
    webhookUrl: p.webhook_url,
    thresholdHours: p.threshold_hours,
    status: p.status,
    createdAt: p.created_at,
  };
}

// Register a parametric policy. The insurer's API key and the webhook signing
// secret are returned exactly once, here — only their hash/ciphertext-side
// uses exist afterwards (same one-time contract as integration secrets).
export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth();
    const supabase = await createClient();

    const parsed = CreatePolicySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const apiKey = generateInsurerApiKey();
    const webhookSecret = randomBytes(32).toString("hex");

    const { data: policy, error } = await supabase
      .from("insurance_policies")
      .insert({
        company_id: auth.companyId,
        insurer_label: parsed.data.insurerLabel,
        api_key_hash: hashApiKey(apiKey),
        webhook_url: parsed.data.webhookUrl ?? "",
        webhook_secret: webhookSecret,
        threshold_hours: parsed.data.thresholdHours,
      })
      .select("*")
      .single();
    if (error || !policy) throw new Error(`PERSIST_FAILED: ${error?.message}`);

    return NextResponse.json(
      { policy: serialize(policy), apiKey, webhookSecret },
      { status: 201 }
    );
  } catch (e) {
    return apiError(e, "insurance/policies/POST");
  }
}

export async function GET() {
  try {
    const auth = await requireAuth();
    const supabase = await createClient();

    const { data: policies } = await supabase
      .from("insurance_policies")
      .select("id, insurer_label, webhook_url, threshold_hours, status, created_at")
      .eq("company_id", auth.companyId)
      .order("created_at", { ascending: false });

    return NextResponse.json({ policies: (policies ?? []).map(serialize) });
  } catch (e) {
    return apiError(e, "insurance/policies/GET");
  }
}
