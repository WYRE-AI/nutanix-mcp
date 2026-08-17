/**
 * The 401 gate and health endpoint, over the REAL HTTP stack
 * (createMcpHandler + toNodeHandler) — no Python child needed: initialize is
 * answered by the thin bridge server without touching the pool.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { createBridgeHttpServer, type BridgeHttp } from "../http.js";
import { ChildPool } from "../pool.js";

let bridge: BridgeHttp;
let pool: ChildPool;
let base: string;

const VALID_HEADERS = {
  "X-Nutanix-Pc-Host": "pc.example.com",
  "X-Nutanix-Pc-Api-Key": "fake-key",
};

/** Decode a JSON-RPC message from a streamable-HTTP response (JSON or SSE). */
async function mcpJson(res: Response): Promise<any> {
  const contentType = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (contentType.includes("text/event-stream")) {
    const dataLines = text.split("\n").filter((line) => line.startsWith("data:"));
    return JSON.parse(dataLines[dataLines.length - 1]!.slice(5).trim());
  }
  return JSON.parse(text);
}

beforeAll(async () => {
  pool = new ChildPool({ upstreamBin: "/nonexistent/nutanix-mcp" });
  bridge = createBridgeHttpServer(pool);
  await new Promise<void>((resolve) => bridge.httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = bridge.httpServer.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await bridge.closeMcpHandler();
  await pool.shutdown();
  await new Promise<void>((resolve, reject) =>
    bridge.httpServer.close((err) => (err ? reject(err) : resolve())),
  );
});

describe("GET /health", () => {
  it("returns 200 without any credentials", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.tenants).toBe(0);
  });
});

describe("POST /mcp 401 gate", () => {
  const initBody = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "0.0.0" },
    },
  });
  const post = (headers: Record<string, string>) =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...headers,
      },
      body: initBody,
    });

  it("rejects requests with no credential headers with 401 + JSON-RPC error", async () => {
    const res = await post({});
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.jsonrpc).toBe("2.0");
    expect(body.error.code).toBe(-32001);
    expect(body.error.message).toContain("Unauthorized");
  });

  it("rejects host-only requests (no auth material)", async () => {
    const res = await post({ "X-Nutanix-Pc-Host": "pc.example.com" });
    expect(res.status).toBe(401);
  });

  it("rejects username-without-password requests", async () => {
    const res = await post({
      "X-Nutanix-Pc-Host": "pc.example.com",
      "X-Nutanix-Pc-Username": "admin",
    });
    expect(res.status).toBe(401);
  });

  it("answers initialize for a fully-credentialed request (no child spawn)", async () => {
    const res = await post(VALID_HEADERS);
    expect(res.status).toBe(200);
    const message = await mcpJson(res);
    expect(message.result.serverInfo.name).toBe("nutanix-mcp");
    expect(typeof message.result.protocolVersion).toBe("string");
  });

  it("surfaces child spawn failures as a JSON-RPC error, not a crash", async () => {
    // tools/list DOES require a child; the pool points at a nonexistent
    // binary, so the spawn fails — scoped to this request.
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...VALID_HEADERS,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    const message = await mcpJson(res);
    expect(message.error).toBeDefined();
    expect(String(message.error.message)).toContain("Nutanix");
    // ...and the server is still alive afterwards.
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
  });
});

describe("routing", () => {
  it("answers OPTIONS preflight with 204", async () => {
    const res = await fetch(`${base}/mcp`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
  });

  it("404s unknown paths", async () => {
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
  });
});
