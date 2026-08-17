/**
 * Thin per-request MCP server that delegates to a tenant's child session.
 *
 * The v2 SDK's `createMcpHandler(factory, { legacy: 'stateless' })` runs the
 * factory once per HTTP request — for BOTH protocol eras (2025-era classic
 * `initialize` handshake clients, served statelessly, and modern 2026-07-28
 * envelope clients, served natively). The factory reads the gateway's
 * per-request credential headers and returns a thin Server whose
 * `tools/list` and `tools/call` handlers delegate to the pooled child MCP
 * session for that tenant. Tool names PASS THROUGH unchanged.
 */
import { Server, type McpServerFactory } from "@modelcontextprotocol/server";
import { resolveCredentials, type NutanixCredentials } from "./credentials.js";
import type { ChildPool } from "./pool.js";

export const SERVER_NAME = "nutanix-mcp";
export const SERVER_VERSION = "1.0.0";

const MISSING_CREDS_MESSAGE =
  "Missing Nutanix Prism Central credentials. Send X-Nutanix-Pc-Host plus " +
  "X-Nutanix-Pc-Api-Key (or X-Nutanix-Pc-Username and X-Nutanix-Pc-Password).";

/**
 * Create a fresh thin server bound to one tenant's credentials.
 *
 * `creds` may be absent only on paths the HTTP 401 gate did not cover
 * (defensive); handlers then answer a clear error instead of ever falling
 * through to environment credentials — that would be a cross-tenant leak.
 */
export function createBridgeServer(pool: ChildPool, creds?: NutanixCredentials): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      // Upstream's discovery-protocol instructions, captured from the first
      // child session (identical across tenants — derived from the baked
      // API-spec artifacts, not the live PC). Undefined until first spawn.
      ...(pool.instructions ? { instructions: pool.instructions } : {}),
    },
  );

  server.setRequestHandler("tools/list", async () => {
    if (!creds) throw new Error(MISSING_CREDS_MESSAGE);
    const client = await pool.getSession(creds);
    const { tools } = await client.listTools();
    return { tools };
  });

  server.setRequestHandler("tools/call", async (request) => {
    if (!creds) throw new Error(MISSING_CREDS_MESSAGE);
    const client = await pool.getSession(creds);
    try {
      return await client.callTool(request.params);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Nutanix MCP call failed: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}

/** Bind the pool into the McpServerFactory shape `createMcpHandler` consumes. */
export function makeMcpServerFactory(pool: ChildPool): McpServerFactory {
  return (ctx) => {
    const { creds } = resolveCredentials(
      (name) => ctx.requestInfo?.headers.get(name) ?? undefined,
    );
    return createBridgeServer(pool, creds);
  };
}
