# Security Model

This document describes the intended security properties of Duc's Table `0.x`. It is a design model, not a guarantee that the software is free of vulnerabilities. Report discrepancies privately through [SECURITY.md](../SECURITY.md).

## Goals and assets

Duc's Table is designed to protect:

- database passwords and authentication material;
- imported files, local tables, snapshots, query results, saved SQL, and project sessions;
- connection metadata and credential-bearing URIs;
- AI prompts, conversation state, metadata tool results, and approved preview rows;
- the integrity of original files and remote databases; and
- the provenance of executable DuckDB extensions and the packaged AI runtime.

The primary risks are unintended persistence or disclosure, SQL escape into state-changing or external operations, remote writes, cross-project access mistaken for isolation, extension or dependency substitution, credential leakage in diagnostics, and AI egress without meaningful consent.

## Assumptions and non-goals

The model assumes the macOS user account, Keychain, operating system, and installed app have not already been compromised. It does not defend data from an attacker who can read or alter the user's application-support directory, inject code into the running process, control the operating system, or replace a trusted signed dependency.

Duc's Table is a single-user desktop workspace. It is not a multi-tenant database proxy, a general SQL sandbox for hostile users, or an access-control layer in front of remote systems. Use least-privilege read-only remote accounts even though the app also enforces read-only behavior.

## Trust boundaries

| Boundary | Untrusted or sensitive input | Primary controls |
| --- | --- | --- |
| React webview to Go/Wails | IDs, SQL, grid controls, paths selected by the user, AI actions | Backend validation, opaque resource IDs, bounded payloads, sanitized errors |
| Go services to DuckDB | User SQL, file metadata, catalog names, generated internal SQL | Read-only validator, identifier/literal quoting, transactions, serialized mutations |
| Go to macOS Keychain | Connection ID and password | Keychain-only backend allowlist, per-connection key, fail closed |
| DuckDB to remote databases | App-built attach configuration and read queries | Read-only attachments, temporary secrets, fixed provider integrations, read-only test accounts |
| Extension manager to repositories | Extension name and downloaded native code | Autoload/autoinstall disabled, hardcoded allowlist and repository selection, DuckDB signed-extension mechanism |
| Go host to Node sidecar | Provider commands, project context, tool requests and results | JSONL protocol, lazy process, allowlisted environment, host-authoritative tools and redaction |
| Sidecar to AI provider | Prompt, model context, metadata and approved previews | Provider consent, separate preview approval, strict limits, disabled provider-native tools |

## SQL restrictions

User-entered SQL must contain exactly one statement beginning with `SELECT` or `WITH`; one optional trailing semicolon is accepted. The validator understands quoted strings and identifiers plus line and nested block comments, then rejects state-changing or escape tokens.

The denylist covers DDL, DML, attach/detach, install/load, secrets and introspection, configuration and pragmas, filesystem and HTTP operations, and provider functions such as `postgres_execute`, `postgres_query`, `postgres_scan`, and `mongo_scan`. Normal references to catalogs already attached by the app remain available.

Validated SQL is wrapped by the backend and materialized into a local result table. Internal SQL for imports, results, snapshots, secrets, extensions, and attachments is generated separately and is never accepted from the frontend as user SQL. Bypasses of this boundary are security vulnerabilities.

PostgreSQL catalogs are attached with `READ_ONLY`. MongoDB is exposed through an experimental read-only extension. Original files and remote relations are not editable through the UI.

## Credentials and connection metadata

Passwords are stored exclusively in macOS Keychain under the Duc's Table service and connection ID. The credential adapter allowlists the Keychain backend; if it is unavailable, operations fail closed without a plaintext or encrypted-file fallback. An empty password during connection editing preserves the current Keychain item, and saved passwords are never returned to the frontend.

Safe, non-secret connection configuration is stored in the workspace. PostgreSQL credentials are converted to temporary DuckDB secrets and removed on disconnect or shutdown. MongoDB credential-bearing URIs are assembled and escaped only in backend memory. Passwords and complete credential URIs must not enter workspace tables, Wails payloads/events, browser storage, frontend errors, or logs.

## Extensions and network access

DuckDB's automatic extension install and load settings are disabled for every application connection. The backend extension manager recognizes only:

- `excel` from DuckDB's core repository;
- `postgres` from DuckDB's core repository; and
- experimental `mongo` from the fixed DuckDB community repository after user consent.

The frontend cannot choose an extension or repository. First use may download a
DuckDB-signed extension into the app's private cache; a cached compatible
extension can then work offline. Release builds disable Apple's library
validation for the app host because downloaded DuckDB extensions do not carry
the app publisher's Apple Team ID. Hardened runtime remains enabled, and DuckDB's
extension signature checks, fixed allowlist, fixed repositories, and disabled
autoload/autoinstall settings remain the executable-code controls. Native
extension code and packaged Node/provider binaries remain supply-chain-sensitive
and must be pinned, attributed, and reviewed during releases.

Expected network egress is limited to user-configured database connections or explicit auto-connect, allowlisted extension downloads on first use, and optional AI provider authentication/model/conversation traffic. There is no app account, analytics, telemetry, cloud backend, or automatic file upload.

## Optional AI

AI is disabled until the user selects and authenticates a provider. Before the first prompt in a project, the UI names the provider and requests explicit consent; that choice is stored in the project's local AI settings.

The model receives only the prompt/context and results of project-scoped read-only tools it chooses to call. Those results may include project/source names and IDs, table/catalog/schema/column metadata, row counts, sanitized connection state, and SQL validation output. The model does not receive passwords, credential-bearing URIs, unrestricted database access, or provider-native shell, filesystem, web, plugin, skill, or agent tools.

A query preview requires a separate approval and is capped at 100 rows, 256 KiB, and 10 seconds. Proposed SQL is validated but not executed automatically. Provider authentication and inference are direct optional egress governed by the selected provider's terms and retention behavior; data typed directly into a prompt is intentionally sent.

## Logs and diagnostics

`app.log` is a private local structured log. It can record operation/source IDs, source filename/type/size, stage, duration, outcome, and a sanitized technical error chain. It must not record row contents, query/result payloads, passwords, tokens, credential-bearing URIs, or raw source paths embedded in driver errors.

The active log rotates at 5 MiB and keeps three backups. Logs are never uploaded automatically. Filenames, IDs, connection names, and timing can still be sensitive metadata, so users and contributors must review and redact diagnostics before sharing them.

## Known limitations

Projects are organizational scopes, not security boundaries. Every project shares `workspace.duckdb` and the physical `data` and `result` schemas. Normal UI and service operations check project IDs, but SQL that explicitly names a known physical table may reference it from another project. Use separate operating-system accounts and separate workspaces when mutually untrusted users or datasets require isolation.

Anyone able to access the local workspace as the same operating-system user may be able to inspect its non-Keychain contents. Materialized imports, snapshots, results, SQL, and AI conversation records consume local disk and remain until their documented lifecycle removes them. A remote system or AI provider can retain data it legitimately receives under its own policy.

Read the user-facing handling details in [PRIVACY.md](../PRIVACY.md) and the component/data-flow overview in [architecture.md](architecture.md).
