# Security Policy

Duc's Table is a local-first data application with deliberate boundaries around SQL execution, credentials, network access, extensions, logs, and optional AI egress. We welcome responsible vulnerability reports.

## Supported versions

During the `0.x` series, security fixes are provided only for the latest published release.

| Version | Supported |
| --- | --- |
| Latest published `0.x` release | Yes |
| Earlier `0.x` releases | No |

Before the first public release, reports against the current default branch are still welcome, but development snapshots are not supported releases.

## Reporting a vulnerability

Never open a public issue, discussion, or pull request for a suspected vulnerability. Use GitHub's [private vulnerability reporting](https://github.com/antonioducs/ducs-table/security/advisories/new) for this repository. If that form is unavailable, wait for a private repository reporting channel rather than disclosing the issue publicly.

Provide enough detail to reproduce and assess the issue without including real data or secrets:

- affected Duc's Table version or commit, macOS version, and architecture;
- impact, prerequisites, and whether user interaction is required;
- minimal steps using synthetic files and disposable, read-only database fixtures;
- expected and observed behavior;
- a minimal proof of concept, if safe to share privately;
- fully redacted diagnostics or screenshots; and
- any mitigation or regression range you already identified.

Do not send database dumps, production records, passwords, tokens, private keys, Keychain exports, credential-bearing URIs, provider session data, or raw logs. Source filenames and connection names can also be sensitive; replace them with synthetic values.

## Security-relevant scope

Reports are especially useful when they involve:

- bypasses of the single-statement read-only SQL sandbox, including DDL/DML, attach/detach, secret access, extension operations, filesystem or HTTP writes, and provider escape functions;
- plaintext credential persistence, Keychain isolation or fail-closed behavior, or passwords reaching the frontend;
- leakage through connection URIs, errors, events, bootstrap payloads, logs, exports, or diagnostic redaction;
- AI consent or approval bypasses, unbounded previews, cross-project tool access, unexpected provider egress, or re-enabled provider-native tools;
- arbitrary or unsigned DuckDB extension loading, repository substitution, or broken extension provenance controls; and
- remote writes despite the application's read-only connection and query guarantees.

The [security model](docs/security-model.md) describes assumptions, trust boundaries, and known limitations. The [privacy policy](PRIVACY.md) describes intended data handling.

## What to expect

Maintainers will handle reports on a best-effort basis: privately acknowledge receipt when possible, validate and prioritize the report, coordinate a fix and disclosure where appropriate, and credit the reporter if requested and safe. The project does not promise a response or remediation SLA, and timing depends on severity, reproducibility, maintainer availability, and release constraints.

Please allow reasonable time for investigation before public disclosure. If active exploitation or imminent harm changes the urgency, state that clearly in the private report.
