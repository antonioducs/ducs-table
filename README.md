# Duc's Table

Duc's Table is a private, local-first macOS SQL workspace for files and databases. It combines DuckDB, a virtualized grid, and a CodeMirror SQL editor so CSV, TSV, JSON, JSONL/NDJSON, XLSX, PostgreSQL, MongoDB, and local DuckDB tables can be explored and joined without loading full datasets into React.

## What it does

- Imports one or many data files from a native dialog or drag and drop.
- Connects PostgreSQL as a stable provider and MongoDB as an experimental provider.
- Browses external schemas/databases and relations lazily, including columns when needed.
- Opens external relations in a read-only **Live** grid or copies them into an offline **Snapshot**.
- Runs federated `SELECT`/`WITH` queries across local tables and attached databases.
- Materializes every editor result into local `result.*` storage for fast paging and export after a database disconnects.
- Saves query results as local tables, saves named SQL, and exports entire or filtered/sorted views to CSV.
- Persists local datasets, snapshots, SQL, safe connection metadata, and lightweight layout preferences between launches.

Imported datasets, snapshots, and remote databases are read-only in the UI. Original files and remote data are never modified.

## Connections

### PostgreSQL — stable

PostgreSQL uses DuckDB's official `postgres` extension. Every catalog is attached with `READ_ONLY`. The app configures a bounded per-catalog pool (1–8 connections, default 4), bounded waits, idle cleanup, and health checks.

### MongoDB — experimental

MongoDB uses the DuckDB `mongo` community extension and requires explicit experimental consent. Availability depends on the current DuckDB version and Mac architecture; an unavailable Mongo extension does not affect PostgreSQL or local files. Collection schemas are inferred, so columns and types may vary for heterogeneous documents. Nested maps/lists/unions use the existing serialized cell representation.

The first connect may download the required signed extension into the app's private extension cache. PostgreSQL comes from DuckDB's core repository; MongoDB comes only from DuckDB's fixed `community` repository. The frontend cannot choose an arbitrary extension or repository.

### SQL names

Each connection receives a normalized, unique, immutable catalog alias. External relations use a quoted three-part name:

```sql
SELECT *
FROM "production"."public"."customers";
```

Quote every segment independently when names contain spaces, capitals, quotes, or reserved words.

## Live versus Snapshot

**Live** reads the remote relation on demand in small cached blocks; the UI requests 100 rows at a time for remote grids and reports the active range and elapsed time. Remote grids do not run an automatic `COUNT(*)`; they fetch `LIMIT requested + 1` to determine whether another block exists, and show an unknown total until the final block. Filter-free PostgreSQL pages execute their projection, stable `ORDER BY`, `LIMIT`, and `OFFSET` directly in PostgreSQL so indexed keys can serve the page without a full DuckDB-side sort. PostgreSQL primary/unique keys and MongoDB `_id` are used for stable paging when available. Without a stable key, the UI warns that rows may shift while the source changes.

**Snapshot** copies a relation to a normal local `data.*` table. Snapshots work offline, participate in later SQL and exports, and keep origin/last-refresh metadata. Refresh is a full atomic replacement: cancellation or failure preserves the previous local version. Removing a connection does not remove its snapshots.

## SQL safety

The editor accepts exactly one `SELECT` or `WITH` statement. DDL, DML, attach/detach, install/load, secrets, filesystem writes, HTTP writes, and provider escape hatches such as `postgres_execute`, `postgres_query`, `postgres_scan`, and `mongo_scan` are rejected. Normal references to catalogs attached by the app remain available.

Internal attach, extension, secret, result, and snapshot operations are not passed through user SQL. Federated results are materialized locally before being published as tabs.

Example federated query:

```sql
SELECT c.customer_id, p.segment, m.preferences
FROM data.customers_csv AS c
LEFT JOIN "prod"."public"."profiles" AS p
  ON p.customer_id = c.customer_id
LEFT JOIN "catalog_mongo"."crm"."customers" AS m
  ON m.customer_id = c.customer_id;
```

## Credentials and privacy

See the concise [privacy policy](PRIVACY.md).

Passwords are stored exclusively in macOS Keychain, keyed by the Duc's Table service and connection ID. The Keychain backend is explicitly allowlisted; if it is unavailable, credential operations fail closed with no plaintext or local encrypted-file fallback. Editing a connection with an empty password preserves the current Keychain item, and the UI never receives or prefills a saved password.

Passwords and full credential-bearing URIs are not stored in `workspace.duckdb`, bootstrap payloads, events, Zustand/localStorage, logs, or frontend error details. DuckDB secrets used for PostgreSQL are temporary and removed on disconnect/shutdown. MongoDB URIs are constructed and escaped only in backend memory.

Duc's Table has no account, cloud backend, analytics, telemetry, or file upload. Explicit network operations are limited to:

- connections the user configured or explicitly enabled for auto-connect;
- first-use downloads of the allowlisted DuckDB extensions.

File contents, query results, and snapshots remain in the local Go/DuckDB process and local files.

## Requirements

- macOS on the architecture being built (the initial build is native, not universal)
- Go 1.25 or newer
- Node.js 22 or newer and npm
- Xcode Command Line Tools
- Wails v2 stable

Install Wails if needed:

```sh
go install github.com/wailsapp/wails/v2/cmd/wails@latest
export PATH="$PATH:$(go env GOPATH)/bin"
```

## Development and build

```sh
npm install
npm --prefix frontend install
npm run dev
```

```sh
npm run build
```

The macOS application is written to `build/bin/ducs-table.app`. DuckDB uses CGO, so the build targets the current machine architecture.

## Checks

```sh
gofmt -w <changed-go-files>
go vet ./...
go test ./...
npm run typecheck
npm run lint
npm run test:unit
wails build -clean
```

The standard suite is deterministic and requires no database, Docker, or network. Live provider tests are opt-in:

```sh
DUCS_TEST_POSTGRES_HOST=localhost \
DUCS_TEST_POSTGRES_DATABASE=app \
DUCS_TEST_POSTGRES_USER=reader \
DUCS_TEST_POSTGRES_PASSWORD=secret \
go test ./internal/connections -run TestLivePostgres -v

DUCS_TEST_MONGO_HOSTS=localhost:27017 \
DUCS_TEST_MONGO_DATABASE=app \
DUCS_TEST_MONGO_USER=reader \
DUCS_TEST_MONGO_PASSWORD=secret \
go test ./internal/connections -run TestLiveMongo -v
```

Use isolated fixtures and read-only users. The live tests connect, browse, run a federated materialization, snapshot, export, and reconnect; they skip only when the corresponding environment variables are absent.

## Local workspace

Application state lives under:

```text
~/Library/Application Support/Duc's Table/
├── workspace.duckdb
├── temp/
├── extensions/
└── app.log
```

DuckDB materializes imported files, snapshots, and query results into `workspace.duckdb`. This uses disk space in exchange for fast repeated filtering, SQL, and export. Ephemeral unsaved query results are removed at the next startup.

## XLSX support

Workbook sheet names are inspected locally with Excelize. Data import uses DuckDB's official signed `excel` extension through the same explicit extension manager. The first XLSX import may require a download; later imports use the private cache and work offline. Legacy `.xls`, spreadsheet formula evaluation, and XLSX export are not supported.

## Troubleshooting and limits

- **Keychain unavailable:** unlock the login Keychain and allow the app access. Duc's Table will not fall back to a file.
- **Extension unavailable:** verify network access on first use and that the extension supports the current DuckDB/Mac architecture. A cached extension works offline.
- **Connection error:** verify the read-only account, host/port, SSL/TLS, auth source, and schema scope. Errors are intentionally sanitized and do not echo connection strings.
- **Large remote joins:** DuckDB can push filters/projections, but large cross-source joins still transfer remote data and the single federated session serializes live operations for correctness. Snapshot large relations when repeated analysis is expected.
- Imported tables and snapshots are immutable; there is no cell/schema editor or remote write support.
- There is no built-in SSH tunnel, cloud IAM/OAuth flow, CDC, scheduler, incremental refresh, or Mongo aggregation builder.
- `.xls`, Parquet UI, charts, MySQL, S3/Iceberg/DuckLake UI, XLSX export, and auto-update are not included.
- Nested JSON/Mongo values are serialized rather than displayed as an expandable tree.
