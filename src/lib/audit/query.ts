// Row shaping for the security trail, shared by the list and verify routes.
// Kept out of the route files because an App Router route module may only
// export HTTP handlers.

import type { StoredSecurityEvent } from "./security-log";

export const EVENT_COLUMNS =
  "id, seq, occurred_at, recorded_at, company_id, actor_type, actor_id, " +
  "actor_label, action, resource_type, resource_id, outcome, metadata, " +
  "metadata_hash, prev_hash, entry_hash";

export interface SecurityEventRow extends StoredSecurityEvent {
  /** The database's own clock at insert. A wide gap from occurredAt is itself
   *  worth a look — it is not part of the hashed body. */
  recordedAt: string | null;
}

export function serializeEvent(row: Record<string, unknown>): SecurityEventRow {
  return {
    id: row.id as string,
    seq: Number(row.seq),
    occurredAt: row.occurred_at as string,
    recordedAt: (row.recorded_at as string) ?? null,
    companyId: row.company_id as string,
    actorType: row.actor_type as StoredSecurityEvent["actorType"],
    actorId: (row.actor_id as string) ?? null,
    actorLabel: (row.actor_label as string) ?? "",
    action: row.action as StoredSecurityEvent["action"],
    resourceType: (row.resource_type as string) ?? "",
    resourceId: (row.resource_id as string) ?? "",
    outcome: row.outcome as StoredSecurityEvent["outcome"],
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    metadataHash: row.metadata_hash as string,
    prevHash: row.prev_hash as string,
    entryHash: row.entry_hash as string,
  };
}
