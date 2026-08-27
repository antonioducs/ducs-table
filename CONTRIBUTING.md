# Contributing to Duc's Table

Thank you for helping improve Duc's Table. Contributions can include reproducible bug reports, design feedback, documentation, tests, accessibility improvements, and focused code changes.

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md). For usage questions, feature exploration, and bug-report guidance, see [Support](SUPPORT.md). Report vulnerabilities only through the private process in the [Security Policy](SECURITY.md).

## Before starting

Search existing issues and discussions before opening a new one. Small, well-scoped fixes can go directly to a pull request. Open an issue first for a large feature, architectural change, new data provider, dependency replacement, storage migration, or change to a security or privacy boundary. This lets maintainers and contributors agree on scope before substantial work begins.

Keep pull requests focused. Do not combine unrelated refactors, generated-file churn, or dependency upgrades with a functional change.

## Development requirements

Development currently targets macOS and the machine's native architecture. You need:

- macOS and Xcode Command Line Tools;
- Go 1.25.13 or newer;
- Node.js 22 or newer and npm; and
- Wails v2.15.x.

Install Wails if it is not already available:

```sh
go install github.com/wailsapp/wails/v2/cmd/wails@v2.15.0
export PATH="$PATH:$(go env GOPATH)/bin"
```

Use the committed lockfiles for a reproducible dependency install:

```sh
npm ci
npm --prefix frontend ci
npm --prefix ai-sidecar ci
npm run dev
```

See the [development guide](docs/development.md) for the repository layout, build details, and troubleshooting.

## Required checks

Format changed Go files and run the checks relevant to the change. Before requesting review, the complete local check set is:

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

`npm run build` compiles and packages the architecture-native sidecar and runs `npm run ai:verify`. That verification is offline: it checks the packaged Node runtime, entry point, production dependencies, native packages, notices, and a JSONL `ping`/`shutdown` smoke test.

Add or update tests for behavioral changes. The standard suite must remain deterministic and must not require a database server, Docker, provider authentication, or network access.

## Opt-in live tests

Live provider tests run only when their environment variables are present:

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

Use isolated, disposable fixtures and least-privilege read-only database users. Never point tests at production or personal data. The live tests browse a readable relation, materialize a federated result, create a snapshot, export, disconnect, and reconnect, so fixtures must tolerate those read operations. Additional opt-in Keychain and extension checks are documented in [Development](docs/development.md#opt-in-tests).

## Security and privacy expectations

Never commit or paste real datasets, credentials, tokens, credential-bearing URIs, private source paths, provider conversation data, Keychain material, or unsanitized logs. Tests and screenshots must use synthetic data.

Changes must preserve the project's boundaries. In particular:

- do not weaken the single-statement `SELECT`/`WITH` policy or expose internal attach, secret, extension, filesystem-write, HTTP-write, or provider escape operations to user SQL;
- do not accept arbitrary extension names, repositories, external qualified names, or connection strings from the frontend;
- keep passwords in macOS Keychain and out of DuckDB, frontend state, events, errors, and logs;
- preserve URI, credential, source-path, and row-content redaction; and
- keep AI disabled until consent, tools project-scoped and read-only, query previews separately approved and bounded, and provider-native shell, filesystem, web, plugin, skill, and agent tools disabled.

A change touching these areas should include focused negative tests and a short threat analysis in the pull request. See the [security model](docs/security-model.md).

## Branches and pull requests

1. Branch from the current default branch with a descriptive name such as `fix/grid-pagination`.
2. Keep the branch current, make the smallest coherent change, and update tests and documentation together.
3. Use a conventional-style pull request title, for example `feat: add snapshot retry feedback`, `fix: redact provider errors`, or `docs: clarify live tests`.
4. Explain the user impact, test evidence, privacy or security implications, and any migration or compatibility concern.
5. Resolve review feedback without rewriting unrelated code. Maintainers normally squash-merge accepted pull requests, so the pull request title becomes the primary history entry.

## Licensing of contributions

Duc's Table uses an inbound-equals-outbound model: contributions are accepted under the same [Apache License 2.0](LICENSE) terms as the project. No separate Contributor License Agreement is currently required. You should contribute only material you have the right to submit and preserve applicable third-party notices.
