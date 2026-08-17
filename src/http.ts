/**
 * HTTP layer: routing, CORS, health, and the gateway 401 gate.
 *
 * The 401 rejection lives HERE, before the MCP handler ever runs —
 * `createMcpHandler` has no auth hooks, and a throwing factory would surface
 * as a 500. Missing/invalid credential headers must answer 401 with a
 * JSON-RPC error body and must NEVER fall through to environment
 * credentials (cross-tenant leak).
 */
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { makeMcpServerFactory, SERVER_VERSION } from "./bridge.js";
import { GATEWAY_HEADERS, resolveCredentials } from "./credentials.js";
import type { ChildPool } from "./pool.js";

const CORS_ALLOW_HEADERS = [
  "Content-Type",
  "Accept",
  "Authorization",
  "Mcp-Session-Id",
  "Mcp-Protocol-Version",
  ...GATEWAY_HEADERS,
].join(", ");

export interface BridgeHttp {
  httpServer: HttpServer;
  /** Close the MCP handler (call before closing the HTTP server). */
  closeMcpHandler: () => Promise<void>;
}

export function createBridgeHttpServer(pool: ChildPool): BridgeHttp {
  const mcpHandler: McpHttpHandler = createMcpHandler(makeMcpServerFactory(pool), {
    legacy: "stateless", // dual-era posture — never 'reject' on fleet servers
    onerror: (error) => {
      process.stderr.write(`[ntnx] MCP serving error: ${error instanceof Error ? error.message : String(error)}\n`);
    },
  });
  const handleMcp = toNodeHandler(mcpHandler, {
    onerror: (error) => {
      process.stderr.write(`[ntnx] MCP request adapter error: ${error instanceof Error ? error.message : String(error)}\n`);
    },
  });

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
    res.setHeader("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS);
    res.setHeader("Access-Control-Max-Age", "86400");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // Shallow, unauthenticated liveness probe. Must not touch credentials or
    // spawn children — credentials only arrive per-request via headers.
    if (url.pathname === "/health" || url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          version: SERVER_VERSION,
          tenants: pool.size,
          timestamp: new Date().toISOString(),
        }),
      );
      return;
    }

    if (url.pathname === "/mcp") {
      const { error } = resolveCredentials((name) => {
        const value = req.headers[name];
        return Array.isArray(value) ? value[0] : value;
      });
      if (error) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32001,
              message: `Unauthorized: ${error}`,
              data: { required: GATEWAY_HEADERS },
            },
            id: null,
          }),
        );
        return;
      }

      // The factory re-reads the same headers from ctx.requestInfo per request.
      // Cast: the SDK's NodeIncomingMessageLike declares `method?: string`,
      // which node:http's IncomingMessage rejects under strict optionality.
      await handleMcp(req as unknown as Parameters<typeof handleMcp>[0], res);
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found", endpoints: ["/mcp", "/health"] }));
  });

  return { httpServer, closeMcpHandler: () => mcpHandler.close() };
}
