import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createServiceRoleClient } from "@/lib/supabase/server";
import {
  clientIp,
  hashIp,
  isPlausibleWorkEmail,
  isConsumerDomain,
} from "@/lib/tools/public-tools";

// Lead capture for the weather checker.
//
// Deliberately NOT gated on the quota: someone who has just used their three
// free checks is the most interested visitor on the site, and refusing their
// email because a counter is full would be the single most self-defeating rule
// we could write.
//
// The consumer-domain check is a NUDGE, never a refusal. Plenty of real brokers
// use a personal address, and rejecting one loses a lead to prove a point.
const LeadSchema = z.object({
  email: z.string().min(5).max(254),
  /** What they were looking at. An email with no voyage attached is worth little. */
  context: z
    .object({
      port: z.string().max(120).optional(),
      cargoKey: z.string().max(60).optional(),
      start: z.string().max(40).optional(),
      end: z.string().max(40).optional(),
      totalExceptedHours: z.number().optional(),
    })
    .default({}),
});

export async function POST(req: NextRequest) {
  const parsed = LeadSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const email = parsed.data.email.trim();
  if (!isPlausibleWorkEmail(email)) {
    return NextResponse.json(
      { error: "INVALID_EMAIL", message: "That does not look like an email address." },
      { status: 400 }
    );
  }

  const service = createServiceRoleClient();
  const { error } = await service.from("public_tool_leads").insert({
    email,
    tool: "weather-checker",
    context: parsed.data.context,
    ip_hash: hashIp(clientIp(req.headers)),
  });

  // A failed write must not block the download the visitor came for. Losing a
  // lead row is our problem; making them re-type an email is theirs.
  if (error) {
    return NextResponse.json({ unlocked: true, stored: false });
  }

  return NextResponse.json({
    unlocked: true,
    stored: true,
    consumerDomain: isConsumerDomain(email),
  });
}
