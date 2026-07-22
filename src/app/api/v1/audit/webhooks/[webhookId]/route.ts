import { NextRequest } from "next/server";
import { authenticateApiRequest } from "@/lib/api/authenticate";
import { apiAuthFailure, apiFail, apiOk } from "@/lib/api/respond";

// DELETE /api/v1/audit/webhooks/{id} — remove a registration.
// Scoped by company: a key cannot delete another tenant's webhook, and a
// wrong-tenant id is a 404 rather than a 403 (which would confirm it exists).
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ webhookId: string }> }
) {
  let caller;
  try {
    caller = await authenticateApiRequest(req, "webhooks:manage");
  } catch (e) {
    return apiAuthFailure(e, "v1/audit/webhooks/[id]/DELETE:auth");
  }

  try {
    const { webhookId } = await params;
    const { data, error } = await caller.client
      .from("api_webhooks")
      .delete()
      .eq("id", webhookId)
      .eq("company_id", caller.companyId)
      .select("id");
    if (error) throw new Error(`DELETE_FAILED: ${error.message}`);
    if (!data || data.length === 0) {
      return apiFail(404, "WEBHOOK_NOT_FOUND", "No webhook with that id for this API key.");
    }
    return apiOk({ deleted: webhookId }, caller);
  } catch (e) {
    return apiAuthFailure(e, "v1/audit/webhooks/[id]/DELETE");
  }
}
