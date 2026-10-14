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
 *   2. Requires CONDUIT_S2S_SECRET before listening. MCP_ALLOW_INSECURE_DEV=1
 *      is local-only and binds 127.0.0.1. /mcp then requires X-Gateway-S2S.
 *   3. 401-gates requests missing the X-Nutanix-Pc-* credential headers.
 *      Those headers are the only Prism Central credential source.
 *   4. Lazily spawns one upstream child per credential tuple and holds an
 *      MCP client session over stdio to each (60-min idle eviction).
 *   5. Re-serves the child's tool surface over Streamable HTTP via the v2
 *      SDK's dual-era `createMcpHandler(factory, { legacy: 'stateless' })`.
 *
 *   Tool names pass through unchanged. READ_ONLY_MODE=true is forced on
 *   every child — v1 of this bridge is deliberately read-only.
 *
 * /health and /healthz stay unauthenticated and do not read credentials.
 */
import { startHttpTransport } from "./http.js";

async function main(): Promise<void> {
  const { httpServer, closeMcpHandler, pool } = await startHttpTransport();

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
}

// Vitest imports modules from this package for unit tests. Skip the CLI
// entrypoint there. `node dist/index.js` still starts HTTP.
if (process.env.VITEST !== "true") {
  main().catch((error) => {
    process.stderr.write(
      `[ntnx] fatal startup error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}
