/**
 * HTTP layer: routing, CORS, health, and the gateway 401 gate.
 *
 * The 401 rejection lives HERE, before the MCP handler ever runs —
 * `createMcpHandler` has no auth hooks, and a throwing factory would surface
 * as a 500. Missing/invalid credential headers must answer 401 with a
 * JSON-RPC error body. Prism Central credentials come only from the
 * `X-Nutanix-Pc-*` headers on that request.
 *
 * HTTP startup fails closed (CWE-306). An empty `CONDUIT_S2S_SECRET` used to
 * skip the `X-Gateway-S2S` check. `startHttpTransport` now refuses to listen
 * unless the secret is set and is not a known placeholder.
 * `MCP_ALLOW_INSECURE_DEV=1` is the only bypass: it logs a warning, does not
 * enforce S2S, and binds 127.0.0.1. A non-loopback `MCP_HTTP_HOST` is refused
 * in that mode. A real secret honors `MCP_HTTP_HOST`; when that variable is
 * unset the process keeps the historical `0.0.0.0` bind. The secret value is
 * never logged.
 *
 * `/health` and `/healthz` stay unauthenticated and do not read credentials.
 */
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { makeMcpServerFactory, SERVER_VERSION } from "./bridge.js";
import { GATEWAY_HEADERS, resolveCredentials } from "./credentials.js";
import { verifyS2sHeader, S2S_HEADER } from "./s2s-verify.js";
import { ChildPool } from "./pool.js";

/**
 * Public example values. A copied placeholder must not verify as a real secret.
 * Compared case-insensitively after trim.
 */
const KNOWN_PLACEHOLDER_SECRETS = new Set([
  "replace-with-a-real-secret",
  "your-s2s-secret",
  "your-secret",
  "changeme",
  "change-me",
  "placeholder",
  "secret",
  "example",
  "replace-me",
  "s2s-secret",
]);

const LOOPBACK_HOST = "127.0.0.1";

const MISSING_S2S_SECRET_ERROR =
  "Refusing to start HTTP transport: CONDUIT_S2S_SECRET is empty. " +
  "Set CONDUIT_S2S_SECRET to the gateway-provisioned secret (openssl rand -hex 32), " +
  "or set MCP_ALLOW_INSECURE_DEV=1 for local development only.";

const PLACEHOLDER_S2S_SECRET_ERROR =
  "Refusing to start HTTP transport: CONDUIT_S2S_SECRET is a known placeholder. " +
  "Generate a secret with `openssl rand -hex 32` and set CONDUIT_S2S_SECRET to that value.";

const INSECURE_DEV_WARNING =
  "SECURITY WARNING: CONDUIT_S2S_SECRET is empty and MCP_ALLOW_INSECURE_DEV=1. " +
  "HTTP /mcp is starting with service-to-service authentication DISABLED, bound to 127.0.0.1 only. " +
  "Local development only; do not expose this port.";

const CORS_ALLOW_HEADERS = [
  "Content-Type",
  "Accept",
  "Authorization",
  "Mcp-Session-Id",
  "Mcp-Protocol-Version",
  "X-Gateway-S2S",
  ...GATEWAY_HEADERS,
].join(", ");

export interface BridgeHttp {
  httpServer: HttpServer;
  /** Close the MCP handler (call before closing the HTTP server). */
  closeMcpHandler: () => Promise<void>;
  /**
   * Tenant child pool. The caller shuts it down: `closeMcpHandler()`, then
   * `pool.shutdown()`, then `httpServer.close()`.
   */
  pool: ChildPool;
}

function logError(message: string): void {
  process.stderr.write(`[ntnx] ${message}\n`);
}

function refuseStart(message: string): never {
  logError(message);
  process.exit(1);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** 127.0.0.1, the rest of 127.0.0.0/8, localhost, and ::1. */
function isLoopbackBindHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[(.+)\]$/, "$1");
  if (normalized === "localhost" || normalized === "::1") return true;
  const bare = normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
  const parts = bare.split(".");
  if (parts.length !== 4) return false;
  if (parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  return parts[0] === "127";
}

/**
 * Fail closed. A known placeholder is never a configured secret, including
 * when MCP_ALLOW_INSECURE_DEV=1 is also set. Empty is the only case the dev
 * flag may bypass, and that bypass does not check X-Gateway-S2S.
 */
function resolveS2sSecret(env: NodeJS.ProcessEnv = process.env): { secret: string; insecureDev: boolean } {
  const raw = (env.CONDUIT_S2S_SECRET ?? "").trim();
  if (raw && KNOWN_PLACEHOLDER_SECRETS.has(raw.toLowerCase())) {
    refuseStart(PLACEHOLDER_S2S_SECRET_ERROR);
  }
  if (raw) return { secret: raw, insecureDev: false };
  if (env.MCP_ALLOW_INSECURE_DEV === "1") {
    return { secret: "", insecureDev: true };
  }
  refuseStart(MISSING_S2S_SECRET_ERROR);
}

/**
 * No real secret: force 127.0.0.1. A non-loopback MCP_HTTP_HOST refuses to
 * start. A real secret honors MCP_HTTP_HOST; unset stays 0.0.0.0 so existing
 * container deploys keep their bind.
 */
function resolveBindHost(insecureDev: boolean, env: NodeJS.ProcessEnv = process.env): string {
  const configured = (env.MCP_HTTP_HOST ?? "").trim();
  if (!insecureDev) {
    return configured || "0.0.0.0";
  }
  if (configured === "" || isLoopbackBindHost(configured)) {
    return LOOPBACK_HOST;
  }
  refuseStart(
    `Refusing to start HTTP transport: MCP_ALLOW_INSECURE_DEV=1 without CONDUIT_S2S_SECRET ` +
      `only listens on ${LOOPBACK_HOST}. MCP_HTTP_HOST=${configured} is not loopback. ` +
      `Unset MCP_HTTP_HOST or set it to ${LOOPBACK_HOST}.`,
  );
}

function resolvePort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PORT ?? env.MCP_HTTP_PORT ?? "8080";
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    refuseStart(`Refusing to start HTTP transport: PORT/MCP_HTTP_PORT=${raw} is not a valid TCP port.`);
  }
  return port;
}

/**
 * Build the HTTP server without listening.
 *
 * `s2sSecret` is required. Pass the resolved `CONDUIT_S2S_SECRET`, or `""`
 * only for the `MCP_ALLOW_INSECURE_DEV=1` bypass (skips `X-Gateway-S2S`).
 * The caller listens, then shuts down `closeMcpHandler`, `pool`, and
 * `httpServer` in that order. `startHttpTransport` is the production caller.
 */
export function createBridgeHttpServer(pool: ChildPool, s2sSecret: string): BridgeHttp {
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
      // Empty s2sSecret is only reachable when MCP_ALLOW_INSECURE_DEV=1;
      // startup refuses otherwise. A configured secret is always enforced,
      // before any credential extraction.
      if (s2sSecret && !verifyS2sHeader(headerValue(req.headers[S2S_HEADER]), s2sSecret)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32001,
              message: "Unauthorized: missing or invalid X-Gateway-S2S header (this endpoint only accepts requests signed by the gateway).",
              data: { required: [S2S_HEADER] },
            },
            id: null,
          }),
        );
        return;
      }

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

  return { httpServer, closeMcpHandler: () => mcpHandler.close(), pool };
}

/**
 * Listen for the conduit gateway. Refuses to bind unless CONDUIT_S2S_SECRET
 * is a non-placeholder value, or MCP_ALLOW_INSECURE_DEV=1 forces 127.0.0.1.
 */
export async function startHttpTransport(pool?: ChildPool): Promise<BridgeHttp> {
  const { secret, insecureDev } = resolveS2sSecret();
  const host = resolveBindHost(insecureDev);
  const port = resolvePort();
  if (insecureDev) {
    // stderr, after the loopback bind is accepted, so a refused non-loopback
    // host does not claim the server is starting. The secret is not included.
    logError(INSECURE_DEV_WARNING);
  }

  const activePool = pool ?? new ChildPool();
  const bridge = createBridgeHttpServer(activePool, secret);
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      bridge.httpServer.off("error", onError);
      reject(err);
    };
    bridge.httpServer.once("error", onError);
    bridge.httpServer.listen(port, host, () => {
      bridge.httpServer.off("error", onError);
      process.stderr.write(`[ntnx] nutanix-mcp bridge listening on ${host}:${port}/mcp\n`);
      resolve();
    });
  });
  return bridge;
}
