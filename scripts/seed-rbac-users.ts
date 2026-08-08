/// <reference types="bun-types" />
// Seeds the demo tenant's role test accounts.
//
//   bun run seed:rbac
//
// Creates operator@ and viewer@laygrounded.com inside the SAME company as
// demo2@laygrounded.com, so the RBAC boundaries built in Phase 14 can be walked
// through in a browser: sign in as the operator and watch "Agree this claim",
// "Issue access token" and "Run negotiation" refuse.
//
// Standalone rather than only inside /api/init-demo because that route needs a
// running server and the INIT_DEMO_SECRET header, and this is something you
// want to run once against a fresh database from a terminal.
//
// Reads SUPABASE_SERVICE_ROLE_KEY. Refuses to run without it rather than
// falling back to the anon key, which would fail later with a confusing RLS
// error instead of an obvious missing-credential one.

import { createClient } from "@supabase/supabase-js";
import { RBAC_TEST_USERS } from "../src/lib/auth-helpers";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DEMO_EMAIL = process.env.DEMO_EMAIL ?? "demo2@laygrounded.com";
const PASSWORD = "demo1234";

if (!url || !serviceKey) {
  console.error(
    "✗ NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set (see .env.example)."
  );
  process.exit(1);
}

const db = createClient(url, serviceKey, { auth: { persistSession: false } });

async function main() {
  // The demo tenant is defined as "whatever company the demo admin is in",
  // not a hardcoded uuid: the id differs per environment, and a constant here
  // would seed users into a company that does not exist on a fresh database.
  const { data: demoUserId, error: lookupErr } = await db.rpc("get_user_id_by_email", {
    email_addr: DEMO_EMAIL,
  });
  if (lookupErr) throw new Error(`demo user lookup failed: ${lookupErr.message}`);
  if (!demoUserId) {
    console.error(
      `✗ ${DEMO_EMAIL} does not exist yet. Run the demo bootstrap first (POST /api/init-demo), then re-run this.`
    );
    process.exit(1);
  }

  const { data: membership } = await db
    .from("company_members")
    .select("company_id, companies ( name )")
    .eq("user_id", demoUserId)
    .maybeSingle();

  if (!membership) {
    console.error(`✗ ${DEMO_EMAIL} exists but belongs to no company. Nothing to seed into.`);
    process.exit(1);
  }

  const companyId = membership.company_id as string;
  const companyName =
    (Array.isArray(membership.companies)
      ? membership.companies[0]?.name
      : (membership.companies as { name?: string } | null)?.name) ?? "(unnamed)";

  console.log(`Seeding role accounts into "${companyName}" (${companyId})\n`);

  for (const spec of RBAC_TEST_USERS) {
    const { data: existingId, error: err } = await db.rpc("get_user_id_by_email", {
      email_addr: spec.email,
    });
    if (err) throw new Error(`lookup failed for ${spec.email}: ${err.message}`);

    let userId = existingId as string | null;
    let action = "updated";

    if (userId) {
      await db.auth.admin.updateUserById(userId, { password: PASSWORD });
    } else {
      const { data: created, error: createErr } = await db.auth.admin.createUser({
        email: spec.email,
        password: PASSWORD,
        email_confirm: true,
        user_metadata: { display_name: spec.displayName },
      });
      if (createErr || !created.user) {
        throw new Error(`create failed for ${spec.email}: ${createErr?.message}`);
      }
      userId = created.user.id;
      action = "created";
    }

    // One company per user — see ensureRoleTestUsers().
    await db.from("company_members").delete().eq("user_id", userId).neq("company_id", companyId);

    const { error: memberErr } = await db
      .from("company_members")
      .upsert(
        { company_id: companyId, user_id: userId, role: spec.role },
        { onConflict: "user_id,company_id" }
      );
    if (memberErr) throw new Error(`membership failed for ${spec.email}: ${memberErr.message}`);

    console.log(`  ✓ ${action.padEnd(7)} ${spec.email.padEnd(30)} role=${spec.role}`);
  }

  console.log(`\nAll accounts use the password: ${PASSWORD}`);
  console.log("Sign in as the operator and try Agree / Issue token / Run negotiation — each refuses.");
}

main().catch((e) => {
  console.error("✗", e instanceof Error ? e.message : e);
  process.exit(1);
});
