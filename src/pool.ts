/**
 * Per-tenant child pool for the upstream nutanix/ntnx-api-mcp-server.
 *
 * The upstream server is stdio-ONLY (`nutanix-mcp serve-stdio`) and reads
 * its Prism Central credentials from environment variables at startup, which
 * makes it single-tenant per process. This pool lazily spawns one child per
 * credential tuple and holds an MCP client session over stdio to each:
 *
 *   - Children are keyed by a hash of the credential tuple.
 *   - Concurrent requests for the same tenant share one spawn (the pool
 *     entry is registered synchronously; callers await its connect promise).
 *   - Idle children are evicted after IDLE_EVICT_MS (default 60 min) — the
 *     child has a multi-second cold start (Python imports + parsing ~20 YAML
 *     API specs), so an aggressive evict would make requests after each gap
 *     pay that cold start and risk gateway tool-fetch timeouts.
 *   - Spawn/connect failures stay scoped to the requesting tenant: the entry
 *     is removed and the next request retries a fresh spawn.
 */
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import {
  credentialsToChildEnv,
  hashCredentials,
  type NutanixCredentials,
} from "./credentials.js";

export interface ChildPoolOptions {
  /** Upstream checkout directory (venv + baked artifacts live here). */
  upstreamDir?: string;
  /** Path to the upstream venv's `nutanix-mcp` console script. */
  upstreamBin?: string;
  /** Directory of baked YAML API-spec artifacts shared by all children. */
  artifactsDir?: string;
  /** Writable directory for the upstream's per-process log files. */
  childLogDir?: string;
  /** Idle tenant timeout before a child is evicted (ms). */
  idleEvictMs?: number;
  /** How long to wait for a spawned child to answer the MCP handshake (ms). */
  spawnTimeoutMs?: number;
}

interface TenantChild {
  client: Client;
  connectPromise: Promise<void>;
  lastUsed: number;
  credHash: string;
}

export class ChildPool {
  private readonly children = new Map<string, TenantChild>();
  private readonly sweeper: NodeJS.Timeout;
  private readonly upstreamDir: string;
  private readonly upstreamBin: string;
  private readonly artifactsDir: string;
  private readonly childLogDir: string;
  private readonly idleEvictMs: number;
  private readonly spawnTimeoutMs: number;

  /**
   * Last-known upstream `instructions` (the Nutanix discovery protocol),
   * captured from each child's initialize result. Identical across tenants —
   * it is derived from the shared baked artifacts, not the live PC.
   */
  instructions: string | undefined;

  constructor(options: ChildPoolOptions = {}) {
    this.upstreamDir = options.upstreamDir ?? process.env.NUTANIX_MCP_DIR ?? "/opt/nutanix-mcp";
    this.upstreamBin =
      options.upstreamBin ?? process.env.NUTANIX_MCP_BIN ?? `${this.upstreamDir}/.venv/bin/nutanix-mcp`;
    this.artifactsDir =
      options.artifactsDir ?? process.env.ARTIFACTS_DIR ?? `${this.upstreamDir}/artifacts`;
    this.childLogDir =
      options.childLogDir ?? process.env.CHILD_LOG_DIR ?? "/tmp/nutanix-mcp-logs";
    this.idleEvictMs = options.idleEvictMs ?? Number(process.env.IDLE_EVICT_MS ?? 60 * 60 * 1000);
    this.spawnTimeoutMs =
      options.spawnTimeoutMs ?? Number(process.env.SPAWN_TIMEOUT_MS ?? 60_000);

    this.sweeper = setInterval(() => this.evictIdle(), 60_000);
    this.sweeper.unref();
  }

  get size(): number {
    return this.children.size;
  }

  /** Get (or lazily spawn) the connected MCP client session for a tenant. */
  async getSession(creds: NutanixCredentials): Promise<Client> {
    const credHash = hashCredentials(creds);
    let child = this.children.get(credHash);
    if (!child) {
      child = this.spawn(creds, credHash);
    }
    child.lastUsed = Date.now();
    await child.connectPromise;
    child.lastUsed = Date.now();
    return child.client;
  }

  private spawn(creds: NutanixCredentials, credHash: string): TenantChild {
    const transport = new StdioClientTransport({
      command: this.upstreamBin,
      args: ["serve-stdio"],
      cwd: this.upstreamDir,
      env: {
        ...getDefaultEnvironment(),
        ...credentialsToChildEnv(creds),
        ARTIFACTS_DIR: this.artifactsDir,
        LOG_DIR: this.childLogDir,
      },
      stderr: "pipe",
    });
    // Tag child stderr with the tenant hash for debuggability.
    transport.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[ntnx:${credHash}] ${chunk}`);
    });

    const client = new Client({ name: "nutanix-mcp-bridge", version: "1.0.0" });

    const child: TenantChild = {
      client,
      connectPromise: Promise.resolve(),
      lastUsed: Date.now(),
      credHash,
    };
    // Register BEFORE awaiting so concurrent requests share this spawn.
    this.children.set(credHash, child);

    child.connectPromise = (async () => {
      try {
        await client.connect(transport, { timeout: this.spawnTimeoutMs });
        this.instructions = client.getInstructions() ?? this.instructions;
        // Child died later (crash, OOM, eviction race): drop the pool entry
        // so the next request respawns instead of hitting a dead session.
        client.onclose = () => {
          if (this.children.get(credHash) === child) {
            this.children.delete(credHash);
            process.stderr.write(`[ntnx:${credHash}] child session closed\n`);
          }
        };
      } catch (err) {
        // Spawn/handshake failure — most commonly a missing interpreter
        // (ENOENT) or missing artifacts. Scope it to this tenant: remove the
        // entry, kill the child, and surface the real error to the caller.
        this.children.delete(credHash);
        try {
          await client.close();
        } catch {
          /* ignore */
        }
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to start Nutanix MCP child process: ${message}`);
      }
    })();

    return child;
  }

  private evictIdle(): void {
    const now = Date.now();
    for (const [credHash, child] of this.children) {
      if (now - child.lastUsed > this.idleEvictMs) {
        process.stderr.write(`[ntnx:${credHash}] evicting idle child after ${this.idleEvictMs}ms\n`);
        this.children.delete(credHash);
        child.client.close().catch(() => {
          /* ignore */
        });
      }
    }
  }

  async shutdown(): Promise<void> {
    clearInterval(this.sweeper);
    const closing = [...this.children.values()].map((child) =>
      child.client.close().catch(() => {
        /* ignore */
      }),
    );
    this.children.clear();
    await Promise.all(closing);
  }
}
