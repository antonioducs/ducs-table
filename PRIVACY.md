# Privacy

Duc's Table is a local desktop application with no account, cloud backend, analytics, telemetry, or file upload.

Local files, imported tables, snapshots, saved SQL, materialized query results, and each project's SQL draft/tab/history session stay in the app's local DuckDB workspace. Project sessions, source metadata, SQL, connection configuration, and credentials are not persisted in frontend `localStorage`; only lightweight global layout preferences are stored there.

Passwords are stored exclusively in macOS Keychain and are never written to the workspace database, browser storage, events, or application logs. If Keychain is unavailable, the app does not fall back to a plaintext or locally encrypted credential file.

Connections are global and may be linked to multiple projects without duplicating their configuration or Keychain item. Removing a link does not delete or disconnect the connection. Deleting a connection everywhere removes its metadata, credential, and project links but preserves local snapshots.

The app performs network access only when the user:

- connects or explicitly enables auto-connect for a PostgreSQL or MongoDB database; or
- first uses an allowlisted DuckDB extension that must be downloaded into the app's private cache.

PostgreSQL is attached read-only. MongoDB uses an experimental read-only community extension. SQL entered by the user is limited to a single `SELECT`/`WITH` query, and provider functions that accept arbitrary connection strings or remote SQL are blocked.

Connection errors and events are sanitized: they do not contain passwords, full credential-bearing URIs, DuckDB secret names, or internal attach SQL.

Projects are organizational contexts, not security boundaries. Every project shares the same `workspace.duckdb` file and physical `data`/`result` schemas; a user who knows a physical SQL name can reference it explicitly from another project. Projects should not be used to separate mutually untrusted users or data.
