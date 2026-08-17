# nutanix-mcp

Multitenant Streamable HTTP bridge over [nutanix/ntnx-api-mcp-server](https://github.com/nutanix/ntnx-api-mcp-server) — Nutanix's official Prism Central v4 API MCP server — built so the WYRE conduit gateway can forward per-tenant Nutanix credentials as HTTP headers.

> **Upstream pin:** Nutanix's server is a **technical preview**, pinned here at tag **`v0.8`** (Apache-2.0). See [Bumping the upstream pin](#bumping-the-upstream-pin).

## Why

The upstream server is **stdio-only** (`nutanix-mcp serve-stdio` is its only serve mode) and reads its Prism Central credentials from environment variables at process startup — single-tenant per process. Our gateway is multi-tenant: every request carries the calling org's credentials as HTTP headers, and the vendor container has to translate those headers into something the upstream understands.

Because the upstream has no HTTP mode to proxy to, this bridge holds an **MCP client session over stdio** to each tenant child and re-serves it over Streamable HTTP:

1. Listens on `:8080` with `POST /mcp` and `GET /health`.
2. 401-gates every `/mcp` request on the `X-Nutanix-Pc-*` credential headers (below). Missing/invalid credentials never fall through to environment credentials — that would be a cross-tenant leak.
3. Lazily spawns one `nutanix-mcp serve-stdio` child per credential tuple (keyed by a hash), with the tenant's `PC_*` env vars set, and connects an MCP client to it over stdio.
4. Serves both protocol eras on `/mcp` via the v2 SDK's `createMcpHandler(factory, { legacy: 'stateless' })` — 2025-era `initialize`-handshake clients (the conduit gateway today) and modern 2026-07-28 envelope clients. `tools/list` and `tools/call` delegate to the tenant's child session.
5. Evicts idle children after 60 minutes (`IDLE_EVICT_MS`).

Tool names **pass through unchanged**: the upstream's 24 tools — 20 `{namespace}_execute` tools (aiops, clustermgmt, datapolicies, dataprotection, files, iam, licensing, lifecycle, microseg, monitoring, multidomain, networking, objects, opsmgmt, prism, security, storage, tenancy, vmm, volumes) plus 4 discovery tools (`listOperations`, `getOperationSchema`, `getCodeSample`, `getOperationPermissions`).

## Read-only in v1 — deliberate

Every child is spawned with **`READ_ONLY_MODE=true`** (also the upstream default): the upstream rejects all non-GET operations before they ever reach Prism Central. v1 of this bridge ships read-only as a deliberate fleet decision. Write support would be a reviewed, versioned change to `credentialsToChildEnv()` in `src/credentials.ts` — not a config flip.

## Credential contract

The gateway forwards these headers on every `/mcp` request; the bridge maps them onto the upstream child's environment. **conduit's vendor-config must match this table exactly.**

| Header | Child env var | Required | Notes |
|---|---|---|---|
| `X-Nutanix-Pc-Host` | `PC_HOST` | yes | Prism Central IP or FQDN |
| `X-Nutanix-Pc-Port` | `PC_PORT` | no | Upstream default `9440`. Upstream quirk: any port other than 9440 makes it use `http://`, not `https://` |
| `X-Nutanix-Pc-Username` | `PC_USERNAME` | with password | Basic auth pair |
| `X-Nutanix-Pc-Password` | `PC_PASSWORD` | with username | Basic auth pair |
| `X-Nutanix-Pc-Api-Key` | `PC_API_KEY` | alternative | Sent to PC as the `X-ntnx-api-key` request header; upstream prefers it over basic auth when both are set |
| `X-Nutanix-Pc-Insecure` | `PC_INSECURE` | no | `"true"`/`"false"` — skip TLS verification (default `false`) |

**Validity rule:** `pcHost` present AND (`apiKey` present OR `username`+`password` present). Anything else → **HTTP 401** with a JSON-RPC error body.

`READ_ONLY_MODE=true` is additionally forced on every child (see above).

## API-spec artifacts (baked at build time)

The upstream builds its tool surface from YAML API-spec artifacts, not from the live PC. `nutanix-mcp init` downloads them — and **without** PC credentials it runs in `latest_release` mode against the public `developers.nutanix.com` namespace API (no PC access required; verified empirically: 20 namespaces). The Docker build runs `init` once and bakes the artifacts into the image at `/opt/nutanix-mcp/artifacts`, shared read-only by all tenant children. Consequences:

- `tools/list` and the discovery tools work with **no reachable PC** — only `{namespace}_execute` calls touch Prism Central.
- Artifact versions are the latest public release at image build time, not the tenant PC's exact versions (the upstream's `pc_compatible` mode would need live PC access at spawn). For the read-only v1 surface this is the right trade: shared artifacts, fast tenant spawns.

## Configuration

| Env var | Default | Notes |
|---|---|---|
| `PORT` | `8080` | Public listen port. |
| `NUTANIX_MCP_DIR` | `/opt/nutanix-mcp` | Upstream checkout (venv + artifacts). |
| `NUTANIX_MCP_BIN` | `$NUTANIX_MCP_DIR/.venv/bin/nutanix-mcp` | Upstream console script the bridge spawns. |
| `ARTIFACTS_DIR` | `$NUTANIX_MCP_DIR/artifacts` | Baked YAML API-spec artifacts. |
| `CHILD_LOG_DIR` | `/tmp/nutanix-mcp-logs` | Writable dir for upstream per-process log files. |
| `IDLE_EVICT_MS` | `3600000` | Idle tenant timeout (60 min). |
| `SPAWN_TIMEOUT_MS` | `60000` | Max wait for a child to answer the MCP handshake. |

## Local development

```bash
# 1. Get the upstream at the pinned tag with a venv + artifacts
git clone --branch v0.8 --depth 1 https://github.com/nutanix/ntnx-api-mcp-server ../ntnx-api-mcp-server
cd ../ntnx-api-mcp-server
uv venv .venv && uv pip install .
ARTIFACTS_DIR=$PWD/artifacts .venv/bin/nutanix-mcp init   # no PC creds needed
cd -

# 2. Build and run the bridge against it
npm ci && npm run build && npm test
NUTANIX_MCP_DIR=../ntnx-api-mcp-server node dist/index.js

# 3. Smoke it
curl -s localhost:8080/health
curl -s localhost:8080/mcp -X POST \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H 'X-Nutanix-Pc-Host: pc.example.com' -H 'X-Nutanix-Pc-Api-Key: fake' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"dev","version":"0"}}}'
```

Or build the image (it bakes everything, including a stdio smoke test that fails the build if `serve-stdio` can't answer `tools/list`):

```bash
docker build --platform linux/amd64 -t ghcr.io/wyre-technology/nutanix-mcp:dev .
docker run --rm -p 8080:8080 ghcr.io/wyre-technology/nutanix-mcp:dev
```

## Bumping the upstream pin

The upstream is pinned to the reviewed tag `v0.8` in the `Dockerfile` (`NUTANIX_MCP_REF`) — never `main` (NSA MCP guidance / fleet security baseline). To bump:

1. Review the upstream diff between the current pin and the new tag (tool surface, credential handling, `READ_ONLY_MODE` semantics).
2. Change `NUTANIX_MCP_REF` in the `Dockerfile` and the tag in this README.
3. `docker build` locally — the build-time smoke tests assert the venv entrypoint runs and the stdio tool surface still answers (update the expected tool count if namespaces changed).
4. Land as a `feat:`/`fix:` PR so semantic-release cuts a version.

## License

Apache-2.0. The bundled `ntnx-api-mcp-server` is Apache-2.0 by Nutanix.
