# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Initial release: multitenant Streamable HTTP bridge over `nutanix/ntnx-api-mcp-server` (Nutanix's official Prism Central v4 API MCP server, technical preview, pinned at tag `v0.8`, Apache-2.0).
- Because the upstream is stdio-only, the bridge holds an MCP client session over stdio per tenant child and re-serves it over HTTP: v2 SDK `createMcpHandler(factory, { legacy: 'stateless' })` serving both 2025-era `initialize`-handshake clients and modern 2026-07-28 envelope clients on `POST /mcp`, plus `GET /health`.
- Header-based credential injection (`X-Nutanix-Pc-Host`/`-Port`/`-Username`/`-Password`/`-Api-Key`/`-Insecure` → child `PC_*` env vars). Missing/invalid credentials answer HTTP 401 with a JSON-RPC error body and never fall through to environment credentials.
- Per-tenant lazy spawning of `nutanix-mcp serve-stdio` children keyed by a credential-tuple hash, with 60-minute idle eviction and per-tenant spawn-error surfacing.
- Passthrough of the upstream's full 24-tool surface unchanged: 20 `{namespace}_execute` tools + 4 discovery tools (`listOperations`, `getOperationSchema`, `getCodeSample`, `getOperationPermissions`), including the upstream's discovery-protocol `instructions`.
- **Read-only v1 (deliberate):** every child is forced `READ_ONLY_MODE=true`, so the upstream rejects all non-GET operations before they reach Prism Central. Enabling writes is a reviewed, versioned change — not a config flip.
- YAML API-spec artifacts baked into the Docker image at build time via `nutanix-mcp init` in credential-less `latest_release` mode (public `developers.nutanix.com` API — verified to need no PC access), shared read-only by all tenant children. Build-time smoke tests assert the venv entrypoint runs and `serve-stdio` answers `initialize` + `tools/list` with the full 24-tool surface using fake PC credentials.
- Fleet-standard CI: thin caller of `wyre-technology/.github` `mcp-server-release.yml` (semantic-release → Docker buildx → MCP Registry publish). No deploy job — Nutanix is a conduit-only vendor with no `gwp-nutanix` Container App.
