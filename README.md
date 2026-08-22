# Duc's Table

Duc's Table is a private, local-first macOS desktop application for exploring large CSV, TSV, JSON, JSONL/NDJSON, and XLSX files with DuckDB. It combines a virtualized table with a real SQL workspace, so datasets can be filtered, joined, grouped, saved, and exported without loading the full file into React.

## What it does

- Opens one or many supported files from a native dialog or by drag and drop.
- Shows a small source preview while a background job materializes the dataset in DuckDB.
- Fetches grid rows in blocks and runs filters, sorting, counts, joins, and aggregations in DuckDB.
- Keeps multiple datasets and query results open as tabs.
- Supports `SELECT`, CTEs, `JOIN`, `GROUP BY`, and aggregate queries in a CodeMirror SQL editor.
- Saves query results as reusable local tables and saves named SQL queries.
- Exports an entire source or the filtered/sorted visible view directly to CSV on disk.
- Persists imported datasets, saved tables, queries, and lightweight layout preferences between launches.

Datasets are read-only in this release. The original files are never changed.

## Requirements

- macOS on the architecture being built (the initial build is native, not universal)
- Go 1.25 or newer
- Node.js 22 or newer and npm
- Xcode Command Line Tools
- Wails v2 stable

Install Wails if it is not already on `PATH`:

```sh
go install github.com/wailsapp/wails/v2/cmd/wails@latest
export PATH="$PATH:$(go env GOPATH)/bin"
```

## Development

```sh
npm install
npm --prefix frontend install
npm run dev
```

The development command starts Wails and Vite. No HTTP server is embedded in the production application.

## Build

```sh
npm run build
```

The macOS application is written to `build/bin/ducs-table.app`. The build targets the current machine architecture because DuckDB uses CGO.

## Checks

```sh
gofmt -w .
go vet ./...
go test ./...
npm run typecheck
npm run lint
npm run test:unit
wails build -clean
```

## Local workspace

On macOS, application state lives under:

```text
~/Library/Application Support/Duc's Table/
├── workspace.duckdb
├── temp/
├── extensions/
└── app.log
```

DuckDB materializes imported files into `workspace.duckdb`; this uses additional disk space in exchange for fast repeated filtering, SQL, and export. Source files remain untouched. Ephemeral query-result tables are removed at the next startup if they were not saved.

## XLSX support

Workbook sheet names are inspected locally with Excelize. Data import uses DuckDB's official signed `excel` extension. The first XLSX import may require a network connection so DuckDB can install that extension into the app-specific `extensions/` cache. Subsequent XLSX imports use the local cache. File contents are never uploaded.

The legacy `.xls` format, formulas-as-a-spreadsheet-engine, and XLSX export are not supported.

## SQL safety

The editor accepts a single read-only `SELECT` or `WITH` query. DDL, DML, and multiple statements are rejected. Results are materialized through a controlled application operation so they can be paged and exported efficiently. Dataset SQL names are shown in the sidebar and may differ from their display filenames when normalization or collision handling is necessary.

## Privacy

Duc's Table has no account, cloud backend, analytics, telemetry, or file upload. Data processing happens in the local Go/DuckDB process. The only optional network operation is the initial download of DuckDB's official XLSX extension. Cell contents are not written to logs.

## Current limitations

- macOS only; the build is for the current CPU architecture and is self-signed, not notarized.
- Imported datasets are immutable; there is no cell editing.
- No `.xls`, Parquet UI, charts, external database connections, XLSX export, or auto-update.
- Very large sorted/filtered random seeks can still incur DuckDB `OFFSET` work; the unfiltered path remains block-oriented and stable.
- Nested JSON values are displayed as readable serialized values rather than an expandable tree.
