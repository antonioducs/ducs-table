# Privacy

Duc's Table is a local desktop application with no account, cloud backend, analytics, telemetry, or file upload.

Local files, imported tables, snapshots, saved SQL, and materialized query results stay in the app's local DuckDB workspace. Passwords are stored exclusively in macOS Keychain and are never written to the workspace database, browser storage, events, or application logs. If Keychain is unavailable, the app does not fall back to a plaintext or locally encrypted credential file.

The app performs network access only when the user:

- connects or explicitly enables auto-connect for a PostgreSQL or MongoDB database; or
- first uses an allowlisted DuckDB extension that must be downloaded into the app's private cache.

PostgreSQL is attached read-only. MongoDB uses an experimental read-only community extension. SQL entered by the user is limited to a single `SELECT`/`WITH` query, and provider functions that accept arbitrary connection strings or remote SQL are blocked.

Connection errors and events are sanitized: they do not contain passwords, full credential-bearing URIs, DuckDB secret names, or internal attach SQL.
