# Contributing to nutanix-mcp

Thanks for your interest in contributing!

## Development setup

See the [Local development](README.md#local-development) section of the README — you need Node 20+, Python 3.11+, and [uv](https://github.com/astral-sh/uv) to run the upstream child locally.

```bash
npm ci
npm run build
npm test
```

## Ground rules

- **Conventional commits** (`feat:`, `fix:`, `docs:`, `chore:`, …) — releases are cut by semantic-release, so the commit type drives versioning.
- **Keep the credential contract frozen.** The `X-Nutanix-Pc-*` header → `PC_*` env mapping in `src/credentials.ts` is mirrored by conduit's vendor-config; changing it is a coordinated, breaking change.
- **Read-only stays read-only** unless a maintainer signs off: `READ_ONLY_MODE=true` is forced in `credentialsToChildEnv()` deliberately.
- **Never bump the upstream pin casually.** `NUTANIX_MCP_REF` in the `Dockerfile` is a reviewed tag; follow [Bumping the upstream pin](README.md#bumping-the-upstream-pin).
- **Tests must pass** (`npm test`) and the Docker image must build (`docker build .`) — the build embeds a stdio smoke test that asserts the upstream tool surface.
- Update `CHANGELOG.md` ([keepachangelog](https://keepachangelog.com/en/1.1.0/) format) for anything user-visible.

## Pull requests

1. Fork/branch from `main`.
2. Make your change with tests.
3. Open a PR — CI runs build + lint + tests on every PR via the fleet reusable workflow.
