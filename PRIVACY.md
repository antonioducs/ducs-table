# Privacy

Duc's Table is a local desktop application with no app account, cloud backend, analytics, telemetry, or automatic file upload. Its optional AI assistant can send user-approved data to OpenAI Codex or Anthropic Claude as described below.

Local files, imported tables, snapshots, saved SQL, materialized query results, and each project's SQL draft/tab/history session stay in the app's local DuckDB workspace. Project sessions, source metadata, SQL, connection configuration, and credentials are not persisted in frontend `localStorage`; only lightweight global layout preferences are stored there.

Passwords are stored exclusively in macOS Keychain and are never written to the workspace database, browser storage, events, or application logs. If Keychain is unavailable, the app does not fall back to a plaintext or locally encrypted credential file.

Connections are global and may be linked to multiple projects without duplicating their configuration or Keychain item. Removing a link does not delete or disconnect the connection. Deleting a connection everywhere removes its metadata, credential, and project links but preserves local snapshots.

The app performs network access only when the user:

- connects or explicitly enables auto-connect for a PostgreSQL or MongoDB database; or
- first uses an allowlisted DuckDB extension that must be downloaded into the app's private cache; or
- chooses an AI provider and performs authentication, model discovery, or an AI conversation.

PostgreSQL is attached read-only. MongoDB uses an experimental read-only community extension. SQL entered by the user is limited to a single `SELECT`/`WITH` query, and provider functions that accept arbitrary connection strings or remote SQL are blocked.

Connection errors and events are sanitized: they do not contain passwords, full credential-bearing URIs, DuckDB secret names, or internal attach SQL.

## Optional AI egress and consent

The AI assistant is optional. Before sending the first prompt in a project, Duc's Table displays a consent dialog naming the provider and describing the data that may leave the device. The consent choice is stored in that project's local DuckDB AI settings and never sent as account data. Query previews are not covered by that one-time consent: each preview requires a separate, explicit approval and is capped at 100 rows, 256 KiB, and 10 seconds.

Depending on the request and tool calls selected by the model, OpenAI or Anthropic may receive:

- the user's prompt, selected model, system instructions, and provider conversation/session context;
- project/source names and IDs, local table/result names, schemas, relation and column metadata, row counts, and sanitized connection names, provider types, catalogs, and statuses;
- SQL submitted for validation or proposal and the corresponding validation result; and
- after separate approval, bounded query-preview columns and rows.

Database passwords, credential-bearing URIs, usernames/hosts from connection configuration, and unrestricted database access are not exposed to the AI providers. Provider-native shell, filesystem, web, plugin, skill, and agent tools are disabled. The only available data tools are project-scoped and read-only; proposed SQL is not executed automatically.

Provider authentication and inference are direct optional egress to the selected provider and are subject to that provider's privacy, retention, and account terms. Duc's Table stores its conversation records locally, while the provider may also retain account or conversation data under those terms. Codex uses a personal ChatGPT/Codex login. Claude requires a personal Claude.ai subscription and a locally installed Claude Code CLI authenticated with Claude.ai; API-key-only Claude authentication is not supported.

Projects are organizational contexts, not security boundaries. Every project shares the same `workspace.duckdb` file and physical `data`/`result` schemas; a user who knows a physical SQL name can reference it explicitly from another project. Projects should not be used to separate mutually untrusted users or data.
