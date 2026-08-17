#!/usr/bin/env node
/**
 * Multitenant Streamable HTTP bridge over nutanix/ntnx-api-mcp-server.
 *
 * Why this exists:
 *   Nutanix's first-party MCP server is stdio-ONLY (`nutanix-mcp
 *   serve-stdio`) and reads its Prism Central credentials from environment
 *   variables at startup — single-tenant per process. The conduit gateway
 *   forwards per-tenant credentials as HTTP headers on every request, so
 *   this bridge:
 *
 *   1. Listens on :8080 with POST /mcp and GET /health.
 *   2. 401-gates requests missing the X-Nutanix-Pc-* credential headers.
 *   3. Lazily spawns one upstream child per credential tuple and holds an
 *      MCP client session over stdio to each (60-min idle eviction).
 *   4. Re-serves the child's tool surface over Streamable HTTP via the v2
 *      SDK's dual-era `createMcpHandler(factory, { legacy: 'stateless' })`.
 *
 *   Tool names pass through unchanged. READ_ONLY_MODE=true is forced on
 *   every child — v1 of this bridge is deliberately read-only.
 */
import { createBridgeHttpServer } from "./http.js";
import { ChildPool } from "./pool.js";

const PORT = Number(process.env.PORT ?? process.env.MCP_HTTP_PORT ?? 8080);
const HOST = process.env.MCP_HTTP_HOST ?? "0.0.0.0";

const pool = new ChildPool();
const { httpServer, closeMcpHandler } = createBridgeHttpServer(pool);

httpServer.listen(PORT, HOST, () => {
  process.stderr.write(`[ntnx] nutanix-mcp bridge listening on http://${HOST}:${PORT}/mcp\n`);
});

async function shutdown(signal: string): Promise<void> {
  process.stderr.write(`[ntnx] received ${signal}, shutting down\n`);
  try {
    await closeMcpHandler();
    await pool.shutdown();
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
  } finally {
    process.exit(0);
  }
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
