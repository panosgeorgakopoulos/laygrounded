/// <reference types="bun-types" />
// The write contract shared by the M2M ingestion route and the workspace panel.
//
// The thing worth testing here is not that an insert happens — it is the SHAPE
// of what lands. Events extracted from unstructured text must arrive as
// `suggested`, because `loadClaimComputationInputs` reads only `accepted` and
// `edited`. An event that landed as `accepted` would move a laytime figure
// without anyone having looked at it, and nothing downstream would report that
// as unusual.

import { describe, expect, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  MULTIMODAL_MIME,
  ensureMultimodalDocument,
  persistSuggestedSofEvents,
} from "./sof-text-server";
import type { ExtractedSofEvent } from "./multimodal";

const EVENTS: ExtractedSofEvent[] = [
  {
    event_type: "NOR_TENDERED",
    occurred_at: "2026-03-04T08:00:00+08:00",
    raw_text: "Notice of Readiness tendered",
    line: 3,
  },
  {
    event_type: "ALL_FAST",
    occurred_at: "2026-03-04T14:00:00+08:00",
    raw_text: "Vessel all fast alongside",
    line: 7,
  },
];

/** Records what the client was asked to do, without a database. */
function fakeClient(opts: { existingDoc?: string | null } = {}) {
  const calls: Array<{ table: string; op: string; payload?: unknown }> = [];

  const client = {
    from(table: string) {
      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        limit() {
          return this;
        },
        maybeSingle: async () => {
          calls.push({ table, op: "select" });
          return { data: opts.existingDoc ? { id: opts.existingDoc } : null, error: null };
        },
        insert(payload: unknown) {
          calls.push({ table, op: "insert", payload });
          return {
            select: () => ({
              single: async () => ({ data: { id: "doc-new" }, error: null }),
              // The event insert selects without .single().
              then: undefined,
            }),
          };
        },
      };
    },
  };

  return { client: client as unknown as SupabaseClient, calls };
}

describe("ensureMultimodalDocument", () => {
  test("reuses the existing stub rather than stacking one per paste", async () => {
    const { client, calls } = fakeClient({ existingDoc: "doc-1" });
    expect(await ensureMultimodalDocument(client, "claim-1")).toBe("doc-1");
    expect(calls.filter((c) => c.op === "insert")).toEqual([]);
  });

  test("creates one when absent, tagged so the viewer can recognise it", async () => {
    const { client, calls } = fakeClient({ existingDoc: null });
    expect(await ensureMultimodalDocument(client, "claim-1")).toBe("doc-new");
    const insert = calls.find((c) => c.op === "insert");
    expect((insert?.payload as Record<string, unknown>).mime).toBe(MULTIMODAL_MIME);
    expect((insert?.payload as Record<string, unknown>).claim_id).toBe("claim-1");
  });
});

describe("persistSuggestedSofEvents", () => {
  /** Captures the rows handed to insert(). */
  function capturingClient() {
    let captured: Array<Record<string, unknown>> = [];
    const client = {
      from() {
        return {
          insert(rows: Array<Record<string, unknown>>) {
            captured = rows;
            return {
              select: async () => ({
                data: rows.map((_, i) => ({ id: `e${i}`, raw_text: "x" })),
                error: null,
              }),
            };
          },
        };
      },
    };
    return { client: client as unknown as SupabaseClient, rows: () => captured };
  }

  test("every event lands as `suggested`, never accepted", async () => {
    const { client, rows } = capturingClient();
    await persistSuggestedSofEvents(client, "claim-1", "doc-1", EVENTS);
    expect(rows().map((r) => r.status)).toEqual(["suggested", "suggested"]);
  });

  test("carries the source so the timeline can say where an event came from", async () => {
    const { client, rows } = capturingClient();
    await persistSuggestedSofEvents(client, "claim-1", "doc-1", EVENTS);
    expect(new Set(rows().map((r) => r.source))).toEqual(new Set(["multimodal"]));
  });

  test("a zeroed bbox, not a fabricated region", async () => {
    // The extractor works on text and has no rendered page to point at. A made-up
    // box would make the viewer highlight the wrong part of a document.
    const { client, rows } = capturingClient();
    await persistSuggestedSofEvents(client, "claim-1", "doc-1", EVENTS);
    expect(rows()[0].bbox).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  test("an unchecked event records NULL, which is not the same as failed", async () => {
    const { client, rows } = capturingClient();
    // Only line 3 was geofenced; line 7 was never checked.
    await persistSuggestedSofEvents(
      client,
      "claim-1",
      "doc-1",
      EVENTS,
      new Map([[3, false]])
    );
    expect(rows()[0].ais_geofence_verified).toBe(false);
    expect(rows()[1].ais_geofence_verified).toBeNull();
  });

  test("preserves the extracted timestamp and type verbatim", async () => {
    const { client, rows } = capturingClient();
    await persistSuggestedSofEvents(client, "claim-1", "doc-1", EVENTS);
    expect(rows()[0].occurred_at).toBe("2026-03-04T08:00:00+08:00");
    expect(rows()[0].event_type).toBe("NOR_TENDERED");
    expect(rows()[1].event_type).toBe("ALL_FAST");
  });
});
