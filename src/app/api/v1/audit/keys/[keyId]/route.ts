import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/server-auth";
import { createClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/api-errors";

// DELETE /api/v1/audit/keys/{id} — revoke a key.
//
// Revoke, not delete: the row is the audit trail of what that credential was
// allowed to do and when it was last used. Deleting it would erase the record
// of an integration that may have written data — exactly what you want to
// look at after a leak. authenticateApiRequest refuses any key whose status
// is not 'active', so revocation takes effect on the next request.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ keyId: string }> }
) {
  try {
    const auth = await requireAuth();
    const { keyId } = await params;
    const supabase = await createClient();

    const { data, error } = await supabase
      .from("api_keys")
      .update({ status: "revoked", revoked_at: new Date().toISOString() })
      .eq("id", keyId)
      .eq("company_id", auth.companyId)
      .eq("status", "active")
      .select("id, label, key_prefix");
    if (error) throw new Error(`REVOKE_FAILED: ${error.message}`);
    if (!data || data.length === 0) {
      return NextResponse.json(
        { error: "KEY_NOT_FOUND", message: "No active key with that id for this company." },
        { status: 404 }
      );
    }

    return NextResponse.json({ revoked: data[0].id, keyPrefix: data[0].key_prefix });
  } catch (e) {
    return apiError(e, "v1/audit/keys/[id]/DELETE", { REVOKE_FAILED: 503 });
  }
}
