// MCP protocol dispatch — JSON-RPC 2.0 over HTTP, with a small registry of
// real, scope-gated, company-scoped tools.
//
// The transport (src/app/api/mcp/route.ts) owns the HTTP request and the
// bearer check; this module owns the protocol and the tools. Every tool runs
// through the SAME service-role client the route authenticated, filtered to
// the caller's company_id — so an MCP token can never reach another tenant's
// claims, and the tool code cannot forget to scope, because the companyId is
// threaded through from the token, not taken from tool input.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { McpCaller } from "./bearer";
import { DEFAULT_CP_TERMS } from "@/lib/laytime/types";
import {
  CpTermsSchema,
  loadClaimComputationInputs,
  recomputeLaytimeServerFn,
} from "@/lib/laytime/recompute-server";
import { analyzeSensitivity } from "@/lib/laytime/sensitivity";
import { runComplianceScan } from "@/lib/compliance/service";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "laygrounded-mcp", version: "1.0.0" };

// JSON-RPC 2.0 envelopes.
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// JSON-RPC error codes (the spec's reserved range).
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

function ok(id: JsonRpcRequest["id"], result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, result };
}
function err(id: JsonRpcRequest["id"], code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

interface ToolContext {
  db: SupabaseClient;
  caller: McpCaller;
}

interface ToolDef {
  name: string;
  description: string;
  scope: string; // the OAuth scope required to call it
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

function textResult(value: unknown, isError = false) {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
    isError,
  };
}

// A required, non-empty string tool argument, trimmed. Tool bodies throw plain
// Errors; dispatch turns them into an isError result the model relays cleanly.
function reqStr(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || !v.trim()) throw new Error(`${key} is required.`);
  return v.trim();
}

// The tenant boundary for any claim-scoped tool. db is the service-role client
// (RLS is bypassed), so every tool that reaches a claim must prove it belongs
// to the token's company HERE — the companyId comes from the token, never from
// tool input, so a caller cannot name another tenant's claim id and reach it.
async function requireClaim(
  ctx: ToolContext,
  claimId: string,
  columns = "id"
): Promise<Record<string, unknown>> {
  const { data } = await ctx.db
    .from("claims")
    .select(columns)
    .eq("id", claimId)
    .eq("company_id", ctx.caller.companyId)
    .maybeSingle();
  if (!data) throw new Error("No claim with that id in your company.");
  // db.select() with a dynamic column string yields a loose row type; the
  // tenancy predicate above is what makes this row safe to return.
  return data as unknown as Record<string, unknown>;
}

// The subset of CP-terms fields update_cp_terms accepts. Anything provided is
// merged onto the claim's existing terms and the WHOLE result is re-validated,
// so a partial amendment cannot leave cp_terms incomplete or invalid.
const CP_TERM_KEYS = [
  "laytime_allowed_hours",
  "turn_time_hours",
  "nor_variant",
  "days_basis",
  "demurrage_rate",
  "despatch_rate",
  "currency",
  "cp_form",
  "load_rate",
  "discharge_rate",
  "port_timezone",
] as const;

const TOOLS: ToolDef[] = [
  {
    name: "list_claims",
    description:
      "List laytime/demurrage claims in your company, newest first. Optionally filter by status.",
    scope: "claims:read",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Optional status filter, e.g. draft, demurrage, despatch." },
        limit: { type: "number", description: "Max rows (1–100, default 25)." },
      },
    },
    run: async (args, { db, caller }) => {
      const limit = Math.min(Math.max(Number(args.limit) || 25, 1), 100);
      let q = db
        .from("claims")
        .select("id, vessel, voyage_ref, port, cargo, status, counterparty_name, updated_at")
        .eq("company_id", caller.companyId) // the tenant boundary, from the token
        .order("updated_at", { ascending: false })
        .limit(limit);
      if (typeof args.status === "string" && args.status) q = q.eq("status", args.status);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return { count: data?.length ?? 0, claims: data ?? [] };
    },
  },
  {
    name: "get_claim",
    description:
      "Get one claim by id: its particulars, charter-party terms and latest laytime calculation.",
    scope: "claims:read",
    inputSchema: {
      type: "object",
      properties: { claim_id: { type: "string", description: "The claim id (uuid)." } },
      required: ["claim_id"],
    },
    run: async (args, { db, caller }) => {
      const claimId = String(args.claim_id ?? "");
      if (!claimId) throw new Error("claim_id is required.");
      const { data: claim } = await db
        .from("claims")
        .select(
          "id, vessel, voyage_ref, port, cargo, status, cp_form, cp_terms, counterparty_name, vessel_imo, time_bar_days, updated_at"
        )
        .eq("id", claimId)
        .eq("company_id", caller.companyId) // cannot fetch another tenant's claim
        .maybeSingle();
      if (!claim) throw new Error("No claim with that id in your company.");

      const { data: calc } = await db
        .from("laytime_calculations")
        .select("demurrage_amount, despatch_amount, total_laytime_used_hours, allowed_hours, computed_at")
        .eq("claim_id", claimId)
        .order("computed_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      return { claim, latestCalculation: calc ?? null };
    },
  },
  {
    name: "create_claim",
    description:
      "Create a new laytime/demurrage claim in your company. Starts as a draft with default GENCON 94 terms (amend them with update_cp_terms). Returns the new claim id.",
    scope: "claims:write",
    inputSchema: {
      type: "object",
      properties: {
        vessel: { type: "string", description: "Vessel name." },
        voyage_ref: { type: "string", description: "Your voyage / charter reference." },
        port: { type: "string", description: "Load or discharge port." },
        cargo: { type: "string", description: "Cargo description, e.g. 'Iron ore fines'." },
        cp_form: {
          type: "string",
          description: "Charter-party form: GENCON94 (default) or ASBATANKVOY.",
        },
        vessel_imo: { type: "string", description: "Optional IMO number." },
        counterparty_name: { type: "string", description: "Optional charterer/owner counterparty." },
      },
      required: ["vessel", "voyage_ref", "port", "cargo"],
    },
    run: async (args, { db, caller }) => {
      const cpForm =
        typeof args.cp_form === "string" && args.cp_form ? args.cp_form : "GENCON94";
      if (cpForm !== "GENCON94" && cpForm !== "ASBATANKVOY") {
        throw new Error("cp_form must be GENCON94 or ASBATANKVOY.");
      }
      const { data: claim, error } = await db
        .from("claims")
        .insert({
          company_id: caller.companyId, // the tenant boundary, from the token — never from input
          vessel: reqStr(args, "vessel"),
          voyage_ref: reqStr(args, "voyage_ref"),
          port: reqStr(args, "port"),
          cargo: reqStr(args, "cargo"),
          cp_form: cpForm,
          cp_terms: DEFAULT_CP_TERMS,
          vessel_imo: typeof args.vessel_imo === "string" ? args.vessel_imo.slice(0, 16) : null,
          counterparty_name:
            typeof args.counterparty_name === "string" ? args.counterparty_name.slice(0, 200) : null,
          created_by: caller.userId,
          status: "draft",
        })
        .select("id, vessel, voyage_ref, port, cargo, cp_form, status, created_at")
        .single();
      if (error) throw new Error(error.message);

      // Mirror POST /api/claims: fire-and-forget compliance/sanctions screening
      // of the new claim and counterparty. The tool never blocks on an external
      // API, and a scan failure only logs. db is already the service-role client.
      void runComplianceScan(claim.id, db).catch((e) =>
        console.error("[mcp create_claim] compliance scan failed:", e)
      );

      return { created: true, claim };
    },
  },
  {
    name: "update_cp_terms",
    description:
      "Amend a claim's charter-party terms (send only the fields you want to change) and recompute its laytime. Returns the merged terms and the new demurrage/despatch totals.",
    scope: "claims:write",
    inputSchema: {
      type: "object",
      properties: {
        claim_id: { type: "string", description: "The claim id (uuid)." },
        laytime_allowed_hours: { type: "number", description: "Total laytime allowed, in hours." },
        turn_time_hours: { type: "number", description: "Turn time before laytime starts, in hours." },
        nor_variant: { type: "string", description: "WIBON | WIPON | WICCON | WIFPON." },
        days_basis: {
          type: "string",
          description: "SHINC | SHEX | SHEX-UU | WWDSHEX-EIU | SSHEX | SSHEX-UU | WWDSSHEX-EIU.",
        },
        demurrage_rate: { type: "number", description: "Demurrage rate per day." },
        despatch_rate: { type: "number", description: "Despatch rate per day." },
        currency: { type: "string", description: "ISO 4217 currency, e.g. USD." },
        cp_form: { type: "string", description: "GENCON94 | ASBATANKVOY." },
        load_rate: { type: "number", description: "Load rate (tonnes/day), optional." },
        discharge_rate: { type: "number", description: "Discharge rate (tonnes/day), optional." },
        port_timezone: { type: "string", description: "IANA timezone, e.g. Asia/Singapore." },
      },
      required: ["claim_id"],
    },
    run: async (args, { db, caller }) => {
      const claimId = reqStr(args, "claim_id");

      // Tenancy check first: the token cannot reach another company's claim,
      // even though db is the service role (which bypasses RLS).
      const { data: claim } = await db
        .from("claims")
        .select("id, cp_terms")
        .eq("id", claimId)
        .eq("company_id", caller.companyId)
        .maybeSingle();
      if (!claim) throw new Error("No claim with that id in your company.");

      const patch: Record<string, unknown> = {};
      for (const k of CP_TERM_KEYS) if (args[k] !== undefined) patch[k] = args[k];
      if (Object.keys(patch).length === 0) throw new Error("Provide at least one term to change.");

      // Merge onto the existing terms and validate the WHOLE object with the
      // same schema recompute uses, so what we store is always complete and
      // valid — never a half-applied partial.
      const merged = { ...(claim.cp_terms as Record<string, unknown>), ...patch };
      const parsed = CpTermsSchema.safeParse(merged);
      if (!parsed.success) {
        throw new Error(
          "Invalid terms: " +
            parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")
        );
      }

      const { error: upErr } = await db
        .from("claims")
        .update({
          cp_terms: parsed.data,
          // Keep the top-level column in sync with the terms, as the app's PATCH
          // route does — dashboards and analytics filter on it.
          cp_form: parsed.data.cp_form ?? "GENCON94",
          updated_at: new Date().toISOString(),
        })
        .eq("id", claimId)
        .eq("company_id", caller.companyId);
      if (upErr) throw new Error(upErr.message);

      // Recompute against the claim's confirmed events and persist the result,
      // so the AI client sees the money impact of the amendment immediately.
      const result = await recomputeLaytimeServerFn(claimId, db);
      return { updated: true, cpTerms: parsed.data, totals: result.totals };
    },
  },
  {
    name: "get_laytime_breakdown",
    description:
      "Get the hour-by-hour laytime breakdown and demurrage/despatch totals from a claim's latest calculation, with the clause reference and reasoning for each interval.",
    scope: "analysis:read",
    inputSchema: {
      type: "object",
      properties: { claim_id: { type: "string", description: "The claim id (uuid)." } },
      required: ["claim_id"],
    },
    run: async (args, ctx) => {
      const claimId = reqStr(args, "claim_id");
      await requireClaim(ctx, claimId);
      const { data: calc } = await ctx.db
        .from("laytime_calculations")
        .select(
          "breakdown, used_hours, allowed_hours, demurrage_amount, despatch_amount, currency, computed_at"
        )
        .eq("claim_id", claimId)
        .order("computed_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!calc) {
        return {
          hasCalculation: false,
          message: "No calculation yet — confirm events or amend terms to produce one.",
        };
      }
      return {
        hasCalculation: true,
        computedAt: calc.computed_at,
        totals: {
          usedHours: calc.used_hours,
          allowedHours: calc.allowed_hours,
          demurrageAmount: calc.demurrage_amount,
          despatchAmount: calc.despatch_amount,
          currency: calc.currency,
        },
        breakdown: calc.breakdown,
      };
    },
  },
  {
    name: "get_negotiation_intel",
    description:
      "Analyse a claim's dispute sensitivity ('attack surface'): the amendments a counterparty could argue to move money against you, and the counters you could push — each ranked by net money moved from the owner's perspective. Computed live from the confirmed events; nothing is persisted.",
    scope: "analysis:read",
    inputSchema: {
      type: "object",
      properties: { claim_id: { type: "string", description: "The claim id (uuid)." } },
      required: ["claim_id"],
    },
    run: async (args, ctx) => {
      const claimId = reqStr(args, "claim_id");
      // Tenancy proven first, so loading via the service role below is safe.
      await requireClaim(ctx, claimId);
      const { cpTerms, sofInputs } = await loadClaimComputationInputs(claimId, ctx.db);
      return analyzeSensitivity(sofInputs, cpTerms);
    },
  },
  {
    name: "get_evidence",
    description:
      "Get the independent evidence-verification verdicts for a claim: how each claimed weather-delay window and the NOR position checked out against the ERA5 weather archive and AIS (corroborated / contradicted / inconclusive / unavailable).",
    scope: "analysis:read",
    inputSchema: {
      type: "object",
      properties: { claim_id: { type: "string", description: "The claim id (uuid)." } },
      required: ["claim_id"],
    },
    run: async (args, ctx) => {
      const claimId = reqStr(args, "claim_id");
      await requireClaim(ctx, claimId);
      const { data: checks } = await ctx.db
        .from("evidence_checks")
        .select("event_id, check_type, verdict, summary, checked_at")
        .eq("claim_id", claimId)
        .order("checked_at", { ascending: false });
      return {
        count: checks?.length ?? 0,
        checks: (checks ?? []).map((c) => ({
          eventId: c.event_id,
          checkType: c.check_type,
          verdict: c.verdict,
          summary: c.summary,
          checkedAt: c.checked_at,
        })),
      };
    },
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Handles one JSON-RPC message. Returns a response, or null for a notification
 * (a request with no id — the client expects no reply).
 */
export async function dispatchMcp(
  message: JsonRpcRequest,
  ctx: ToolContext
): Promise<JsonRpcResponse | null> {
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return err(message.id ?? null, INVALID_REQUEST, "Malformed JSON-RPC request.");
  }

  const isNotification = message.id === undefined || message.id === null;

  switch (message.method) {
    case "initialize":
      return ok(message.id, {
        // Echo the client's protocol version when we support it, else ours.
        protocolVersion:
          (message.params?.protocolVersion as string) || MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });

    case "notifications/initialized":
    case "notifications/cancelled":
      return null; // notifications get no response

    case "ping":
      return ok(message.id, {});

    case "tools/list":
      return ok(message.id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });

    case "tools/call": {
      const name = message.params?.name as string;
      const args = (message.params?.arguments as Record<string, unknown>) ?? {};
      const tool = TOOL_BY_NAME.get(name);
      if (!tool) return err(message.id, INVALID_PARAMS, `Unknown tool: ${name}`);

      // Scope enforcement lives here, per tool. A token that read-authorized
      // cannot reach a write tool. Reported as a tool error (isError) rather
      // than a transport error, so the model relays it cleanly to the user.
      if (!ctx.caller.scopes.includes(tool.scope)) {
        return ok(
          message.id,
          textResult(
            `Permission denied: this connection was not granted the "${tool.scope}" scope needed for ${name}.`,
            true
          )
        );
      }

      try {
        const result = await tool.run(args, ctx);
        return ok(message.id, textResult(result));
      } catch (e) {
        // Tool-level failure → isError result, not a JSON-RPC error.
        return ok(message.id, textResult(`Error: ${e instanceof Error ? e.message : String(e)}`, true));
      }
    }

    default:
      if (isNotification) return null;
      return err(message.id, METHOD_NOT_FOUND, `Method not found: ${message.method}`);
  }
}

export const JSON_RPC_CODES = { PARSE_ERROR, INVALID_REQUEST, METHOD_NOT_FOUND, INVALID_PARAMS, INTERNAL_ERROR };
