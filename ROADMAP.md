# Roadmap

## Vision

Duc's Table aims to be a trustworthy macOS workspace for exploring local files and read-only databases with SQL. It should make useful analysis fast without turning a desktop tool into an implicit cloud service or loading entire datasets into the webview.

## Principles

- Local-first storage and useful offline workflows.
- Read-only originals and remote sources by default and by enforcement.
- Explicit, bounded network and AI egress.
- Backend validation at every bridge boundary; the frontend is not a security authority.
- Paged and materialized data flows instead of unbounded frontend payloads.
- Reproducible builds, migrations, tests, and extension provenance.
- Small, reviewable increments with privacy and failure behavior documented.

## Status

The project is in the `0.x` phase. File workflows and PostgreSQL are the stable core; MongoDB and the optional AI assistant remain explicitly experimental or optional. Storage schemas, integrations, and user-facing workflows may evolve before `1.0`, with migrations provided where practical.

This roadmap communicates direction, not a commitment. Items may move as reliability, security findings, maintainer capacity, and contributor interest change. No dates are promised.

## Now

- Prepare and validate the first public open-source release, including governance, licensing, security documentation, and a repeatable macOS release process.
- Stabilize imports, project session restoration, SQL materialization, paging, CSV export, snapshots, and read-only PostgreSQL workflows.
- Keep deterministic local tests broad, add negative tests around SQL/credential/AI boundaries, and keep live-provider tests isolated and opt-in.
- Improve diagnostics and recovery while preserving URI, credential, path, and row-content redaction.
- Continue compatibility work for the experimental MongoDB extension and optional Codex/Claude integrations without weakening consent or provenance controls.

## Next

Candidate priorities after the initial `0.x` release:

- Project portability and lifecycle features such as explicit import/export, duplicate, move/copy, and carefully designed deletion.
- Better visibility and controls for large remote joins, long-running work, snapshots, and disk use.
- A signed and notarized distribution pipeline, checksums, stronger release metadata, and groundwork for a safe update experience.
- Broader local format ergonomics, including evaluating a first-class Parquet UI, while retaining immutable-source behavior.
- Accessibility, keyboard workflow, and grid/editor polish based on real usage.

## Later

Longer-term ideas, subject to demand and a security/privacy design review:

- Additional read-only providers and object/table formats such as MySQL, S3, Iceberg, or DuckLake.
- Charts, expandable nested values, and additional export formats such as XLSX.
- Advanced connection options such as SSH tunnels or cloud IAM/OAuth.
- Scheduling, incremental refresh, and change-data workflows.

See the current capabilities and explicit limits in the [README](README.md). Discuss substantial proposals before implementation as described in [CONTRIBUTING.md](CONTRIBUTING.md).
