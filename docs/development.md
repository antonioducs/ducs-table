# Development

This guide covers a reproducible local setup for the current macOS application. See [CONTRIBUTING.md](../CONTRIBUTING.md) before proposing a substantial change.

## Prerequisites

- macOS on the architecture being built
- Go 1.25.13 or newer
- Node.js 22 or newer and npm
- Xcode Command Line Tools
- Wails v2.15.x

Install Wails if needed:

```sh
go install github.com/wailsapp/wails/v2/cmd/wails@v2.15.0
export PATH="$PATH:$(go env GOPATH)/bin"
```

Confirm the active tools before diagnosing build failures:

```sh
go version
node --version
npm --version
wails version
xcode-select -p
```

## Reproducible setup

The root, frontend, and sidecar each have a committed npm lockfile. Install exactly those dependency graphs and the pinned Wails CLI:

```sh
make install
```

Start development mode from the repository root:

```sh
make dev
```

`make dev` adds the Go bin directory to the command's `PATH`, compiles the AI sidecar, and starts `wails dev`; Wails runs the frontend Vite watcher. The sidecar process itself starts lazily when an AI operation needs it. The underlying `npm run dev` command remains available when Wails is already on your shell `PATH`.

## Repository structure

| Path | Purpose |
| --- | --- |
| `main.go`, `app*.go` | Wails lifecycle, bridge surface, orchestration, and app-level tests |
| `internal/` | Go services for DuckDB, workspace, import, grid, query, export, jobs, connections, credentials, extensions, logs, and AI policy |
| `frontend/` | React/TypeScript workbench, unit tests, Vite, ESLint, and generated Wails-facing types |
| `ai-sidecar/` | Node 22 TypeScript adapters for Codex and Claude plus JSONL protocol tests |
| `scripts/` | Build-process preflight and sidecar staging, packaging, signing, and offline verification |
| `testdata/` | Small synthetic local import fixtures |
| `build/` | Wails metadata/assets and generated macOS output |

For component boundaries and data flows, read [architecture.md](architecture.md).

## Commands

Run commands from the repository root unless noted otherwise.

| Command | Purpose |
| --- | --- |
| `npm run dev` | Compile the sidecar and run Wails/Vite development mode |
| `gofmt -w <changed-go-files>` | Format changed Go files |
| `go vet ./...` | Vet all Go packages |
| `go test ./...` | Run Go unit and local integration tests |
| `npm run typecheck` | Run the frontend TypeScript build/type check without pretty output |
| `npm run lint` | Run frontend ESLint and the repository Go-format check |
| `npm run test:unit` | Run frontend Vitest once |
| `npm run ai:test` | Run sidecar Vitest once |
| `npm run ai:compile` | Compile sidecar TypeScript to `ai-sidecar/dist` |
| `npm run build` | Build, package, sign, and verify the native macOS app |
| `npm run ai:verify` | Verify an already packaged sidecar and run its offline smoke test |

The complete pre-review check sequence is:

```sh
gofmt -w <changed-go-files>
go vet ./...
go test ./...
npm run typecheck
npm run lint
npm run test:unit
npm run ai:test
npm run build
```

The standard suite is deterministic and requires no external database, Docker, provider authentication, or network. Go tests create temporary DuckDB workspaces; frontend and sidecar tests use in-process fakes and synthetic values.

## Opt-in tests

Live PostgreSQL and MongoDB tests run only when the required environment variables are set. Use disposable fixtures and read-only users; never use production or personal data.

```sh
DUCS_TEST_POSTGRES_HOST=localhost \
DUCS_TEST_POSTGRES_DATABASE=app \
DUCS_TEST_POSTGRES_USER=reader \
DUCS_TEST_POSTGRES_PASSWORD=fixture-password \
go test ./internal/connections -run TestLivePostgres -v

DUCS_TEST_MONGO_HOSTS=localhost:27017 \
DUCS_TEST_MONGO_DATABASE=app \
DUCS_TEST_MONGO_USER=reader \
DUCS_TEST_MONGO_PASSWORD=fixture-password \
go test ./internal/connections -run TestLiveMongo -v
```

Optional variables cover ports, TLS/auth modes, and schema scope; inspect `internal/connections/live_integration_test.go` before using a non-default fixture. These tests connect, browse, federate, snapshot, export, disconnect, and reconnect, but they must not modify the remote database.

Two narrower checks are also opt-in because they touch the host Keychain or network:

```sh
DUCS_TEST_KEYCHAIN=1 \
go test ./internal/credentials -run TestLiveMacOSKeychainRoundTrip -v

DUCS_TEST_EXTENSIONS=1 \
go test ./internal/connections -run TestPostgresExtensionSecretCompatibility -v
```

The Keychain test creates a uniquely named temporary item and removes it. The extension test may download DuckDB's official PostgreSQL extension into a temporary workspace.

## Production build

Stop `wails dev` and close any app running from `build/bin` before building. The preflight refuses to proceed while either process can race with Wails output cleanup.

```sh
npm run build
```

The result is `build/bin/Duc's Table.app` for the current machine architecture; the initial build is not universal. DuckDB uses CGO, so a working Xcode toolchain is required.

The build compiles the sidecar, stages production dependencies and a copy of the current Node executable, runs Wails, copies the architecture-native sidecar under `Contents/Resources/ai-sidecar`, signs the completed bundle, and verifies it offline. Local builds use ad-hoc signing by default. Set `DUCS_CODESIGN_IDENTITY` for an intended distribution identity, or set `DUCS_SKIP_CODESIGN=1` only when a later packaging step will sign the completed bundle.

Release artifacts have additional signing and notarization requirements; see [releasing.md](releasing.md).

## Troubleshooting

- **`wails` not found:** confirm `$(go env GOPATH)/bin` is on `PATH` and rerun `wails version`.
- **CGO or SDK failure:** run `xcode-select -p`, accept any required Xcode license, and verify Go is using the intended architecture.
- **Dependency mismatch:** verify Node 22 or newer, then rerun the appropriate `npm ci`; do not hand-edit generated dependency trees or discard lockfiles.
- **Build reports a running process:** stop `wails dev` and quit the built app before retrying.
- **Workspace lock error:** use the existing Duc's Table window and close older development or production instances. They share the default workspace and build output.
- **Keychain prompt or failure:** unlock the login Keychain and allow the current build access. Ad-hoc development signatures can change identity; re-enter the fixture credential if prompted.
- **Extension unavailable:** first use needs network access and a build compatible with the current DuckDB/macOS architecture. Automatic arbitrary extension loading is intentionally disabled.
- **Sidecar verification failure:** read the reported missing runtime, native package, notice, or entry point; rebuild with `npm run build`. `npm run ai:verify` does not authenticate or contact AI providers.

Do not share raw `app.log` contents in a public issue. Use the displayed short reference and sanitize any excerpt according to [SECURITY.md](../SECURITY.md).
