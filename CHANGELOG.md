# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the project is in `0.x`, minor releases may contain breaking changes; those changes will be called out in release notes.

## [Unreleased]

### Added

- Apache-2.0 licensing, NOTICE attribution, and bundled third-party material in
  preparation for open-source distribution.
- Contributor, conduct, security, support, roadmap, architecture, security-model, development, and release documentation.
- Continuous integration, macOS build verification, guarded notarized releases,
  dependency updates, and secret-history scanning.
- Structured bug, feature, and pull request templates for public collaboration.

### Changed

- Prepared repository policy, version metadata, and release guidance for public
  collaboration.
- Packaged the Duc's Table, Node.js, and third-party notices with the AI sidecar.

### Security

- Updated `github.com/dvsekhvalnov/jose2go` to `v1.7.0`, addressing known
  denial-of-service vulnerabilities in the transitive file-keyring code path.
- Raised the minimum Go version to 1.25.13 so builds include standard-library
  fixes used by XML import, certificate diagnostics, and URL redaction paths.
- Removed the non-cryptographic workbench ID fallback in favor of Web Crypto
  UUIDs.
- Updated the transitive Echo runtime to a release that fixes an encoded-path
  route protection bypass.

[Unreleased]: https://github.com/antonioducs/ducs-table/commits/main
