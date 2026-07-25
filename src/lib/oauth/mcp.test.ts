import { describe, test, expect } from "bun:test";
import { dispatchMcp, MCP_PROTOCOL_VERSION, type JsonRpcRequest } from "./mcp";
import type { McpCaller } from "./bearer";

// The protocol methods below never touch the database; the fake is only here
// to satisfy the type and would throw loudly if a test accidentally reached a
// tool body.
const db = new Proxy({}, { get() { throw new Error("db must not be touched in a protocol test"); } }) as never;

function caller(scopes: string[]): McpCaller {
  return { tokenId: "t", userId: "u", companyId: "c", clientId: "cl", scopes };
}
const ctx = (scopes: string[] = ["claims:read"]) => ({ db, caller: caller(scopes) });

async function call(msg: JsonRpcRequest, scopes?: string[]) {
  return dispatchMcp(msg, ctx(scopes));
}

describe("MCP protocol dispatch", () => {
  test("initialize returns the protocol version, capabilities and server info", async () => {
    const r = await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(r?.result).toMatchObject({
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "laygrounded-mcp" },
    });
  });

  test("initialize echoes a protocol version the client asked for", async () => {
    const r = await call({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    });
    expect((r?.result as { protocolVersion: string }).protocolVersion).toBe("2025-03-26");
  });

  test("tools/list advertises the tools with input schemas", async () => {
    const r = await call({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = (r?.result as { tools: { name: string; inputSchema: unknown }[] }).tools;
    expect(tools.map((t) => t.name).sort()).toEqual([
      "create_claim",
      "get_claim",
      "get_evidence",
      "get_laytime_breakdown",
      "get_negotiation_intel",
      "list_claims",
      "update_cp_terms",
    ]);
    expect(tools.every((t) => t.inputSchema)).toBe(true);
  });

  test("ping returns an empty result", async () => {
    const r = await call({ jsonrpc: "2.0", id: 3, method: "ping" });
    expect(r?.result).toEqual({});
  });

  test("a notification (no id) gets no response", async () => {
    expect(await call({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
  });

  test("an unknown method is a JSON-RPC method-not-found error", async () => {
    const r = await call({ jsonrpc: "2.0", id: 4, method: "does/not/exist" });
    expect(r?.error?.code).toBe(-32601);
  });

  test("a malformed envelope is an invalid-request error", async () => {
    const r = await call({ jsonrpc: "1.0" as never, id: 5, method: "ping" });
    expect(r?.error?.code).toBe(-32600);
  });

  test("tools/call on an unknown tool is invalid params", async () => {
    const r = await call({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "nope", arguments: {} } });
    expect(r?.error?.code).toBe(-32602);
  });

  test("a token lacking the tool's scope gets an isError result, not the data", async () => {
    // caller holds only analysis:read; list_claims needs claims:read.
    const r = await call(
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "list_claims", arguments: {} } },
      ["analysis:read"]
    );
    const result = r?.result as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("claims:read");
  });

  test("a read-only token cannot reach a write tool (scope-gated before the db)", async () => {
    // claims:read authorises the read tools but NOT create_claim/update_cp_terms.
    // The denial is returned before the tool body runs, so the throwing db fake
    // is never touched — proving the gate is the scope check, not a db error.
    for (const name of ["create_claim", "update_cp_terms"]) {
      const r = await call(
        { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name, arguments: {} } },
        ["claims:read"]
      );
      const result = r?.result as { isError: boolean; content: { text: string }[] };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("claims:write");
    }
  });

  test("the analysis tools require analysis:read, not claims:read", async () => {
    // A claims:read token can list/get claims but must NOT reach the analysis
    // intelligence — again denied before the tool body touches the db.
    for (const name of ["get_laytime_breakdown", "get_negotiation_intel", "get_evidence"]) {
      const r = await call(
        {
          jsonrpc: "2.0",
          id: 9,
          method: "tools/call",
          params: { name, arguments: { claim_id: "x" } },
        },
        ["claims:read"]
      );
      const result = r?.result as { isError: boolean; content: { text: string }[] };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("analysis:read");
    }
  });
});
