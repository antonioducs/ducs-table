# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the project is in `0.x`, minor releases may contain breaking changes; those changes will be called out in release notes.

## [Unreleased]

## [0.1.1] - 2026-08-29

### Added

- Signed and notarized macOS DMG distribution with a drag-to-Applications
  installer layout and a separate SHA-256 checksum.

### Fixed

- Published the application bundle as `Duc's Table.app` while preserving the
  existing bundle identifier, Keychain service, and application data identity.

## [0.1.0] - 2026-08-27

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
- Kept the clean-clone embed placeholder stable after development and
  production build commands.
- Hardened the macOS release path with inside-out Developer ID signing, secure
  timestamps, App Store Connect API-key notarization, and explicit rejection of
  development-only signing entitlements.

[Unreleased]: https://github.com/antonioducs/ducs-table/commits/main
