# syntax=docker/dockerfile:1.10
#
# Multitenant Streamable HTTP bridge over nutanix/ntnx-api-mcp-server.
#
# The upstream Nutanix server is stdio-ONLY and reads its Prism Central
# credentials from environment variables at startup. The conduit gateway
# forwards per-tenant credentials as HTTP headers on every request, so this
# image runs a small Node bridge on port 8080 that:
#
#   1. Reads the X-Nutanix-Pc-* credential headers from the incoming request
#      (missing/invalid -> HTTP 401, never a fall-through to env creds)
#   2. Lazily spawns one `nutanix-mcp serve-stdio` child per credential
#      tuple and holds an MCP client session over stdio to each
#   3. Re-serves the child's tool surface over Streamable HTTP (dual-era)
#   4. Evicts idle children after a timeout
#
# The upstream is pinned to the reviewed v0.8 tag (NSA MCP guidance / fleet
# security baseline) — never `main`. To bump: change NUTANIX_MCP_REF below,
# re-review the upstream diff, and cut a release.

# ---- Stage 1: install ntnx-api-mcp-server into a venv via uv ----
# The uv image and the runtime stage are BOTH built on python:3.12-slim-bookworm,
# so the system interpreter lives at /usr/local/bin/python3.12 in both. We pin uv
# to that system python (UV_PYTHON_PREFERENCE=only-system + UV_PYTHON_DOWNLOADS=never)
# so the venv's bin/python symlinks to a path that ALSO exists in the runtime image.
#
# Without this, uv downloads its own managed CPython outside /opt/nutanix-mcp and
# points the venv there — copying only /opt/nutanix-mcp into the runtime stage
# would leave .venv/bin/python a DANGLING symlink, crashing the bridge with
# `spawn ... ENOENT` on the first tool call (gateway-visible as HTTP 502).
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim AS upstream

ENV NUTANIX_MCP_REF=v0.8 \
    UV_PYTHON_PREFERENCE=only-system \
    UV_PYTHON_DOWNLOADS=never
WORKDIR /opt
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN git clone --depth=1 --branch "${NUTANIX_MCP_REF}" \
      https://github.com/nutanix/ntnx-api-mcp-server.git /opt/nutanix-mcp \
 && cd /opt/nutanix-mcp \
 && uv venv .venv --python /usr/local/bin/python3.12 \
 && uv pip install --python /opt/nutanix-mcp/.venv/bin/python .

# Bake the YAML API-spec artifacts at BUILD time. Without PC credentials,
# `nutanix-mcp init` runs in latest_release mode against the public
# developers.nutanix.com namespace API (verified empirically: 20 namespaces,
# no PC access required) — so every tenant child shares this read-only
# artifacts dir and first-spawn latency stays low.
#
# init also writes a `.env` snapshot of its (empty) settings into cwd, and
# the upstream's settings loader reads project-root/.env at startup — remove
# it so nothing baked at build time can ever shadow per-tenant runtime env.
WORKDIR /opt/nutanix-mcp
RUN ARTIFACTS_DIR=/opt/nutanix-mcp/artifacts LOG_DIR=/tmp/build-logs \
      /opt/nutanix-mcp/.venv/bin/nutanix-mcp init \
 && rm -f /opt/nutanix-mcp/.env \
 && ls /opt/nutanix-mcp/artifacts/*.yaml >/dev/null

# ---- Stage 2: build the Node bridge ----
FROM node:26-bookworm-slim AS bridge-build
WORKDIR /app
COPY package.json package-lock.json* tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- Stage 3: runtime image ----
FROM python:3.14-slim AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    NODE_ENV=production \
    PORT=8080

# Install Node.js 22 (no apt repo — use the official tarball)
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
 && curl -fsSL https://nodejs.org/dist/v22.11.0/node-v22.11.0-linux-x64.tar.xz -o /tmp/node.tar.xz \
 && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
 && rm /tmp/node.tar.xz \
 && rm -rf /var/lib/apt/lists/*

# Bring in the upstream + its venv + the baked artifacts
COPY --from=upstream /opt/nutanix-mcp /opt/nutanix-mcp
ENV NUTANIX_MCP_DIR=/opt/nutanix-mcp \
    NUTANIX_MCP_BIN=/opt/nutanix-mcp/.venv/bin/nutanix-mcp \
    ARTIFACTS_DIR=/opt/nutanix-mcp/artifacts \
    CHILD_LOG_DIR=/tmp/nutanix-mcp-logs

# Build-time smoke test 1: run the EXACT venv entrypoint the bridge spawns at
# runtime. If the cross-stage copy ever leaves the venv's python a dangling
# symlink, this fails the build here instead of shipping an image that
# crashes with `spawn ... ENOENT` (-> gateway 502) on the first call.
RUN "${NUTANIX_MCP_BIN}" --help > /dev/null

# Build-time smoke test 2: prove serve-stdio actually starts and answers an
# MCP initialize + tools/list from the baked artifacts with FAKE PC creds
# (tool definitions come from the YAML artifacts, not the live PC — only
# execute calls need a reachable PC). Asserts the full 24-tool surface:
# 20 {namespace}_execute + 4 discovery tools.
RUN printf '%s\n' \
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"build-smoke","version":"0"}}}' \
      '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
      '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' > /tmp/smoke-in.jsonl \
 && { cat /tmp/smoke-in.jsonl; sleep 20; } \
      | env PC_HOST=smoke.invalid PC_USERNAME=smoke PC_PASSWORD=smoke \
            READ_ONLY_MODE=true LOG_DIR=/tmp/build-logs \
            "${NUTANIX_MCP_BIN}" serve-stdio > /tmp/smoke-out.jsonl 2>/dev/null \
 && python3 - <<'EOF'
import json
tools = None
for line in open("/tmp/smoke-out.jsonl"):
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    if msg.get("id") == 2:
        tools = [t["name"] for t in msg["result"]["tools"]]
assert tools is not None, "serve-stdio never answered tools/list"
assert len(tools) == 24, f"expected 24 tools, got {len(tools)}: {tools}"
assert "listOperations" in tools and "vmm_execute" in tools, tools
print(f"stdio smoke OK: {len(tools)} tools")
EOF

# Bring in the compiled bridge
WORKDIR /app
COPY --from=bridge-build /app/node_modules ./node_modules
COPY --from=bridge-build /app/dist ./dist
COPY --from=bridge-build /app/package.json ./package.json

LABEL org.opencontainers.image.source="https://github.com/WYRE-AI/nutanix-mcp" \
      org.opencontainers.image.licenses="Apache-2.0" \
      io.modelcontextprotocol.server.name="io.github.WYRE-AI/nutanix-mcp"

EXPOSE 8080
CMD ["node", "dist/index.js"]
