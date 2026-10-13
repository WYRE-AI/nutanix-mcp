/**
 * HTTP transport fail-closed auth (CWE-306).
 *
 * Startup requires a real CONDUIT_S2S_SECRET. Empty and known placeholders
 * refuse to listen. MCP_ALLOW_INSECURE_DEV=1 is the empty-secret bypass: it
 * binds 127.0.0.1 and refuses a non-loopback MCP_HTTP_HOST.
 * /mcp rejects a missing or invalid X-Gateway-S2S header.
 * Gateway mode rejects requests that omit X-Nutanix-Pc-* credential headers
 * and must not fall back to PC_* in process.env.
 */

import { createHmac } from "node:crypto";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startHttpTransport } from "../http.js";
import { ChildPool } from "../pool.js";

const S2S_SECRET = "s2s-do-not-log-7f3a";
const ENV_HOST = "env-pc-host-must-not-be-used";
const ENV_API_KEY = "env-api-key-must-not-be-used";
const ENV_PASSWORD = "env-password-must-not-be-used";

const ENV_KEYS = [
  "CONDUIT_S2S_SECRET",
  "MCP_ALLOW_INSECURE_DEV",
  "MCP_HTTP_PORT",
  "MCP_HTTP_HOST",
  "PORT",
  "PC_HOST",
  "PC_USERNAME",
  "PC_PASSWORD",
  "PC_API_KEY",
] as const;

const savedEnv = new Map<string, string | undefined>();
const servers: Server[] = [];
const pools: ChildPool[] = [];

function mintS2sHeader(secret: string, unixSeconds = Math.floor(Date.now() / 1000)): string {
  const message = `t=${unixSeconds}`;
  const hex = createHmac("sha256", secret).update(message).digest("hex");
  return `${message},v1=${hex}`;
}

function captureStderr(): { text: () => string; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  return {
    text: () => lines.join(""),
    restore: () => spy.mockRestore(),
  };
}

interface HttpResult {
  status: number;
  body: string;
  contentType: string;
}

function sendHttp(options: {
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port: options.port,
        method: options.method,
        path: options.path,
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            contentType: String(res.headers["content-type"] ?? ""),
          });
        });
      },
    );
    req.setTimeout(5000, () => {
      req.destroy(new Error(`timeout ${options.method} ${options.path}`));
    });
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

async function listen(pool?: ChildPool): Promise<{ port: number; address: string; close: () => Promise<void> }> {
  const bridge = await startHttpTransport(pool);
  servers.push(bridge.httpServer);
  pools.push(bridge.pool);
  const bound = bridge.httpServer.address() as AddressInfo | null;
  if (!bound || typeof bound === "string") {
    throw new Error("HTTP server did not bind a TCP port");
  }
  return {
    port: bound.port,
    address: bound.address,
    close: async () => {
      await bridge.closeMcpHandler();
      await bridge.pool.shutdown();
      if (!bridge.httpServer.listening) return;
      await new Promise<void>((resolve, reject) => {
        bridge.httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

function mcpHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...extra,
  };
}

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

function exitSpy() {
  return vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${String(code)}`);
  }) as typeof process.exit);
}

/** Decode a JSON-RPC message from a streamable-HTTP response (JSON or SSE). */
function mcpJson(body: string, contentType: string): { result?: { serverInfo?: { name?: string } }; error?: { message?: string } } {
  if (contentType.includes("text/event-stream")) {
    const dataLines = body.split("\n").filter((line) => line.startsWith("data:"));
    return JSON.parse(dataLines[dataLines.length - 1]!.slice(5).trim());
  }
  return JSON.parse(body);
}

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  process.env.PORT = "0";
  process.env.MCP_HTTP_PORT = "0";
  process.env.MCP_HTTP_HOST = "127.0.0.1";
  delete process.env.CONDUIT_S2S_SECRET;
  delete process.env.MCP_ALLOW_INSECURE_DEV;
  delete process.env.PC_HOST;
  delete process.env.PC_USERNAME;
  delete process.env.PC_PASSWORD;
  delete process.env.PC_API_KEY;
});

afterEach(async () => {
  vi.restoreAllMocks();
  while (servers.length > 0) {
    const server = servers.pop();
    if (!server?.listening) continue;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
  while (pools.length > 0) {
    const pool = pools.pop();
    await pool?.shutdown();
  }
});

describe("HTTP startup", () => {
  it("refuses to start when CONDUIT_S2S_SECRET is empty", async () => {
    const logs = captureStderr();
    const exit = exitSpy();

    try {
      await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
      expect(exit).toHaveBeenCalledWith(1);
      const text = logs.text();
      expect(text).toContain("Refusing to start HTTP transport");
      expect(text).toContain("CONDUIT_S2S_SECRET is empty");
      expect(text).not.toContain(S2S_SECRET);
    } finally {
      logs.restore();
    }
  });

  it("refuses to start when CONDUIT_S2S_SECRET is whitespace", async () => {
    process.env.CONDUIT_S2S_SECRET = "   ";
    const logs = captureStderr();
    const exit = exitSpy();

    try {
      await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
      expect(exit).toHaveBeenCalledWith(1);
      expect(logs.text()).toContain("CONDUIT_S2S_SECRET is empty");
    } finally {
      logs.restore();
    }
  });

  it("still refuses when MCP_ALLOW_INSECURE_DEV is not exactly 1", async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = "true";
    const logs = captureStderr();
    exitSpy();

    try {
      await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
      expect(logs.text()).toContain("Refusing to start HTTP transport");
    } finally {
      logs.restore();
    }
  });

  it.each(["changeme", "Change-Me", "  replace-with-a-real-secret  ", "your-s2s-secret", "EXAMPLE"])(
    "refuses known placeholder %j and does not log it",
    async (placeholder) => {
      process.env.CONDUIT_S2S_SECRET = placeholder;
      const logs = captureStderr();
      const exit = exitSpy();

      try {
        await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
        expect(exit).toHaveBeenCalledWith(1);
        const text = logs.text();
        expect(text).toContain("known placeholder");
        expect(text).toContain("openssl rand -hex 32");
        expect(text).not.toContain(placeholder.trim());
        expect(text).not.toContain(`CONDUIT_S2S_SECRET=${placeholder.trim()}`);
      } finally {
        logs.restore();
      }
    },
  );

  it("refuses the placeholder word secret without echoing the configured value", async () => {
    process.env.CONDUIT_S2S_SECRET = "secret";
    const logs = captureStderr();
    exitSpy();

    try {
      await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
      const text = logs.text();
      expect(text).toContain("known placeholder");
      expect(text).not.toContain("CONDUIT_S2S_SECRET=secret");
    } finally {
      logs.restore();
    }
  });

  it("refuses a placeholder even when MCP_ALLOW_INSECURE_DEV=1", async () => {
    process.env.CONDUIT_S2S_SECRET = "your-s2s-secret";
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    const logs = captureStderr();
    exitSpy();

    try {
      await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
      const text = logs.text();
      expect(text).toContain("known placeholder");
      expect(text).not.toContain("your-s2s-secret");
      expect(text).not.toContain("SECURITY WARNING");
    } finally {
      logs.restore();
    }
  });

  it("allows startup with a warning when MCP_ALLOW_INSECURE_DEV=1 and binds 127.0.0.1", async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    delete process.env.MCP_HTTP_HOST;
    const logs = captureStderr();
    const exit = exitSpy();
    let close: (() => Promise<void>) | undefined;

    try {
      const server = await listen();
      close = server.close;
      expect(exit).not.toHaveBeenCalled();
      expect(server.address).toBe("127.0.0.1");
      const text = logs.text();
      expect(text).toContain("SECURITY WARNING");
      expect(text).toContain("CONDUIT_S2S_SECRET");
      expect(text).toContain("MCP_ALLOW_INSECURE_DEV=1");
      expect(text).toContain("127.0.0.1");
      expect(text).not.toContain(S2S_SECRET);
    } finally {
      logs.restore();
      await close?.();
    }
  });

  it("forces 127.0.0.1 when the dev bypass host is localhost", async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    process.env.MCP_HTTP_HOST = "localhost";
    const logs = captureStderr();
    let close: (() => Promise<void>) | undefined;

    try {
      const server = await listen();
      close = server.close;
      expect(server.address).toBe("127.0.0.1");
      expect(logs.text()).toContain("SECURITY WARNING");
      expect(logs.text()).toContain("listening on 127.0.0.1");
    } finally {
      logs.restore();
      await close?.();
    }
  });

  it.each(["0.0.0.0", "10.1.2.3"])("refuses the dev bypass when MCP_HTTP_HOST is %s", async (host) => {
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    process.env.MCP_HTTP_HOST = host;
    const logs = captureStderr();
    const exit = exitSpy();

    try {
      await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
      expect(exit).toHaveBeenCalledWith(1);
      const text = logs.text();
      expect(text).toContain("Refusing to start HTTP transport");
      expect(text).toContain("MCP_ALLOW_INSECURE_DEV");
      expect(text).toContain("127.0.0.1");
      expect(text).toContain(`MCP_HTTP_HOST=${host}`);
      expect(text).toContain("not loopback");
      expect(text).not.toContain("SECURITY WARNING");
      expect(text).not.toContain(S2S_SECRET);
    } finally {
      logs.restore();
    }
  });

  it("honors a non-loopback MCP_HTTP_HOST when CONDUIT_S2S_SECRET is set", async () => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.MCP_HTTP_HOST = "0.0.0.0";
    const logs = captureStderr();
    let close: (() => Promise<void>) | undefined;

    try {
      const server = await listen();
      close = server.close;
      expect(server.address).toBe("0.0.0.0");
      expect(logs.text()).not.toContain("not loopback");
      expect(logs.text()).not.toContain(S2S_SECRET);
    } finally {
      logs.restore();
      await close?.();
    }
  });

  it("keeps the 0.0.0.0 bind when a secret is set and MCP_HTTP_HOST is unset", async () => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    delete process.env.MCP_HTTP_HOST;
    const server = await listen();
    expect(server.address).toBe("0.0.0.0");
    await server.close();
  });
});

describe("HTTP /mcp authentication", () => {
  beforeEach(() => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.MCP_HTTP_HOST = "127.0.0.1";
    process.env.PC_HOST = ENV_HOST;
    process.env.PC_API_KEY = ENV_API_KEY;
    process.env.PC_PASSWORD = ENV_PASSWORD;
  });

  it("returns 401 when the S2S header is missing or invalid and does not log the secret", async () => {
    const logs = captureStderr();
    const pool = new ChildPool({ upstreamBin: "/nonexistent/nutanix-mcp" });
    const getSession = vi.spyOn(pool, "getSession");
    let close: (() => Promise<void>) | undefined;

    try {
      const server = await listen(pool);
      close = server.close;
      const missing = await sendHttp({
        port: server.port,
        method: "POST",
        path: "/mcp",
        headers: mcpHeaders(),
        body: initBody,
      });
      const invalid = await sendHttp({
        port: server.port,
        method: "POST",
        path: "/mcp",
        headers: mcpHeaders({ "x-gateway-s2s": mintS2sHeader("wrong-secret") }),
        body: initBody,
      });

      expect(missing.status).toBe(401);
      expect(invalid.status).toBe(401);
      expect(missing.body).toContain("X-Gateway-S2S");
      expect(invalid.body).toContain("X-Gateway-S2S");
      expect(missing.body).not.toContain(S2S_SECRET);
      expect(invalid.body).not.toContain(S2S_SECRET);
      expect(missing.body).not.toContain(ENV_HOST);
      expect(missing.body).not.toContain(ENV_API_KEY);
      expect(missing.body).not.toContain(ENV_PASSWORD);
      expect(logs.text()).not.toContain(S2S_SECRET);
      expect(getSession).not.toHaveBeenCalled();
    } finally {
      logs.restore();
      await close?.();
    }
  });

  it("returns 401 in gateway mode without credential headers and does not use env credentials", async () => {
    const pool = new ChildPool({ upstreamBin: "/nonexistent/nutanix-mcp" });
    const getSession = vi.spyOn(pool, "getSession");
    const server = await listen(pool);

    try {
      const response = await sendHttp({
        port: server.port,
        method: "POST",
        path: "/mcp",
        headers: mcpHeaders({ "x-gateway-s2s": mintS2sHeader(S2S_SECRET) }),
        body: initBody,
      });

      expect(response.status).toBe(401);
      expect(response.body).toContain("Unauthorized");
      expect(response.body).toContain("X-Nutanix-Pc-Host");
      expect(response.body).not.toContain(ENV_HOST);
      expect(response.body).not.toContain(ENV_API_KEY);
      expect(response.body).not.toContain(ENV_PASSWORD);
      expect(response.body).not.toContain(S2S_SECRET);
      expect(getSession).not.toHaveBeenCalled();

      const partial = await sendHttp({
        port: server.port,
        method: "POST",
        path: "/mcp",
        headers: mcpHeaders({
          "x-gateway-s2s": mintS2sHeader(S2S_SECRET),
          "x-nutanix-pc-host": "pc.example.com",
        }),
        body: initBody,
      });
      expect(partial.status).toBe(401);
      expect(partial.body).toContain("X-Nutanix-Pc-Api-Key");
      expect(partial.body).not.toContain(ENV_API_KEY);
      expect(getSession).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("rejects whitespace-only gateway credential headers", async () => {
    const pool = new ChildPool({ upstreamBin: "/nonexistent/nutanix-mcp" });
    const getSession = vi.spyOn(pool, "getSession");
    const server = await listen(pool);

    try {
      const response = await sendHttp({
        port: server.port,
        method: "POST",
        path: "/mcp",
        headers: mcpHeaders({
          "x-gateway-s2s": mintS2sHeader(S2S_SECRET),
          "x-nutanix-pc-host": "   ",
          "x-nutanix-pc-api-key": "   ",
        }),
        body: initBody,
      });

      expect(response.status).toBe(401);
      expect(response.body).toContain("X-Nutanix-Pc-Host");
      expect(getSession).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("accepts a valid S2S header plus credential headers", async () => {
    const logs = captureStderr();
    const pool = new ChildPool({ upstreamBin: "/nonexistent/nutanix-mcp" });
    const getSession = vi.spyOn(pool, "getSession");
    let close: (() => Promise<void>) | undefined;

    try {
      const server = await listen(pool);
      close = server.close;
      const response = await sendHttp({
        port: server.port,
        method: "POST",
        path: "/mcp",
        headers: mcpHeaders({
          "x-gateway-s2s": mintS2sHeader(S2S_SECRET),
          "x-nutanix-pc-host": "pc.example.com",
          "x-nutanix-pc-api-key": "header-api-key",
        }),
        body: initBody,
      });

      expect(response.status).toBe(200);
      expect(response.body).not.toContain(S2S_SECRET);
      expect(response.body).not.toContain(ENV_HOST);
      expect(response.body).not.toContain(ENV_API_KEY);
      expect(response.body).not.toContain(ENV_PASSWORD);
      const payload = mcpJson(response.body, response.contentType);
      expect(payload.result?.serverInfo?.name).toBe("nutanix-mcp");
      expect(logs.text()).not.toContain(S2S_SECRET);
      expect(getSession).not.toHaveBeenCalled();
    } finally {
      logs.restore();
      await close?.();
    }
  });

  it("serves /health and /healthz without authentication and without reading credentials", async () => {
    const pool = new ChildPool({ upstreamBin: "/nonexistent/nutanix-mcp" });
    const getSession = vi.spyOn(pool, "getSession");
    const server = await listen(pool);

    try {
      for (const path of ["/health", "/healthz"]) {
        const response = await sendHttp({
          port: server.port,
          method: "GET",
          path,
        });
        expect(response.status).toBe(200);
        const body = JSON.parse(response.body) as { status?: string };
        expect(body.status).toBe("ok");
        expect(response.body).not.toContain(S2S_SECRET);
        expect(response.body).not.toContain(ENV_HOST);
        expect(response.body).not.toContain(ENV_API_KEY);
        expect(response.body).not.toContain(ENV_PASSWORD);
      }
      expect(getSession).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});
