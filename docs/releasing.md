# Releasing

This is the maintainer checklist for Duc's Table `0.x`. It describes the intended process; publishing authority, Apple credentials, and GitHub release permissions remain separate operational controls.

## Version policy

Duc's Table follows Semantic Versioning with `vMAJOR.MINOR.PATCH` Git tags. During initial development:

- increment `MINOR` for a feature release or an intentional compatibility break;
- increment `PATCH` for backward-compatible fixes and security updates; and
- describe every storage, privacy, security, provider, and compatibility change explicitly.

Only the latest published `0.x` release receives security fixes. No release date is promised by the roadmap.

## Prepare the release

1. Start from a reviewed default-branch commit with a clean worktree and green required GitHub Actions checks.
2. Choose the version and verify that every change since the prior release is represented under `[Unreleased]` in [CHANGELOG.md](../CHANGELOG.md).
3. Move those entries into a new `## [0.x.y] - YYYY-MM-DD` section. Add a fresh empty `[Unreleased]` section and comparison links only after both endpoint tags exist.
4. Align user-visible version values. Review `wails.json` (`info.productVersion`), frontend and sidecar package manifests and lockfiles, the sidecar `ping` response, provider client identifiers, and any release metadata. Do not blindly change third-party SDK, protocol, migration, or tool-schema versions that have independent meaning.
5. Review [NOTICE](../NOTICE), [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md), direct and bundled transitive dependencies, native sidecar packages, the bundled Node license, and the Apache-2.0 [LICENSE](../LICENSE).
6. Review changes against [PRIVACY.md](../PRIVACY.md), [SECURITY.md](../SECURITY.md), and the [security model](security-model.md). Resolve or document known regressions before tagging.
7. Test workspace migrations and startup cleanup on synthetic copies representing supported upgrade paths. Never use a sole copy of a real user workspace, and do not assume that downgrade after a schema migration is safe.

After version edits, use the committed lockfiles and run the full check set:

```sh
npm ci
npm --prefix frontend ci
npm --prefix ai-sidecar ci
gofmt -w <changed-go-files>
go vet ./...
go test ./...
npm run typecheck
npm run lint
npm run test:unit
npm run ai:test
npm run build
```

The three `npm ci` commands must succeed without lockfile drift. `npm run build` includes the packaged sidecar verification and offline JSONL smoke test.

## Build the macOS artifact

The current build is architecture-native, not universal. The automated public
release currently targets Apple silicon (`arm64`) on `macos-15`. Build and test a
separate app on each additional macOS architecture that a future release claims
to support. The bundled Node executable and Codex/Claude native packages must
match the artifact's architecture.

Before each build, stop `wails dev` and close `build/bin/ducs-table.app`. Build the final app with an Apple distribution signing identity available to the process:

```sh
DUCS_CODESIGN_IDENTITY="Developer ID Application: Example (TEAMID)" npm run build
```

The example identity is a placeholder. Distribution signing and notarization require maintainer-controlled Apple Developer credentials, certificates, entitlements where applicable, and current Apple tooling. Keep those credentials in the CI secret store or local Keychain; never commit or print them.

Before pushing a release tag, configure these secrets in the protected GitHub
`release` environment. They intentionally use the same common CSC and App Store
Connect naming convention as the maintainer's other release workflows:

- `CSC_LINK` — base64-encoded Developer ID Application `.p12`;
- `CSC_KEY_PASSWORD` — password protecting that certificate;
- `CSC_NAME` — certificate name and team identifier without the
  `Developer ID Application:` prefix, for example `Example Name (TEAMID)`;
- `APPLE_API_KEY` — base64-encoded App Store Connect API key `.p8`;
- `APPLE_API_KEY_ID` — App Store Connect API key identifier; and
- `APPLE_API_ISSUER` — App Store Connect API issuer identifier.

Local signing can use the same certificate directly from Keychain and the `.p8`
path already present on the machine. GitHub-hosted runners cannot access the
maintainer's Keychain, so the certificate must be exported as a password-protected
`.p12`; the workflow materializes both binary secrets into temporary files and
removes them after the job.

The release workflow stops before building if any credential is absent and does
not publish until signature verification, notarization, stapling, and Gatekeeper
assessment all succeed.

The sidecar is copied before the build script signs the completed app bundle.
Release signing processes embedded Mach-O executables from the inside out,
removes development-only entitlements from the bundled Node runtime, enables
hardened runtime, requests secure timestamps, and signs the outer app last.
Valid Developer ID signatures and required entitlements supplied by the Codex
and Claude vendors are preserved. After signing, submit the exact distributable
to Apple's notarization service with the App Store Connect API key, wait for
acceptance, staple the ticket where the artifact format supports it, and verify
the final artifact on a clean supported Mac. At minimum, validate the completed
app with:

```sh
codesign --verify --deep --strict --verbose=2 build/bin/ducs-table.app
spctl --assess --type execute --verbose=4 build/bin/ducs-table.app
xcrun stapler validate build/bin/ducs-table.app
```

Do not publish a bundle that is only ad-hoc signed. An ad-hoc signature is for local development, not release distribution. Likewise, a successful CI compile is not a releasable artifact unless signing, notarization, architecture, bundled notices, and clean-machine launch checks all pass.

## Tag and publish

1. Merge the release preparation through the normal pull-request process and rerun required CI on the exact release commit.
2. Create an annotated tag such as `v0.1.0` on that commit. Do not move or reuse a published tag.
3. Push the tag and allow release CI to rebuild or verify the exact tagged source. Compare the produced commit, version, architecture, signature, and notarization result with the approved release record.
4. Create the GitHub release from that tag. Mark pre-releases accurately.
5. Attach only signed, notarized, verified artifacts. Generate and publish SHA-256 checksums for every downloadable artifact.
6. Write release notes from the changelog, highlighting user-visible changes, upgrade/migration behavior, supported macOS architectures, provider or extension compatibility, privacy/security changes, and known limitations.
7. Verify links, download each published asset, recompute its checksum, inspect its signature/notarization, and launch it on a clean supported Mac before announcing the release.

Publishing a machine-readable SBOM for the Go, frontend, sidecar, bundled Node runtime, and native provider packages is a release objective. Until automated SBOM generation is validated, keep lockfiles and `THIRD_PARTY_NOTICES.md` authoritative and state clearly if a release has no SBOM; do not publish an unverified inventory.

## Security releases

Coordinate embargoed work through GitHub private vulnerability reporting. Keep the fix, tests, advisory, CVE request if appropriate, and release notes private until patched artifacts are ready. Avoid proof-of-concept detail that creates unnecessary exploitation risk. Credit reporters according to their preference.

A security release follows the same build, signing, notarization, checksum, and clean-machine verification gates. Update the GitHub advisory and supported-version statement when disclosure occurs.

## Rollback and revocation

Do not silently replace an artifact or retarget a tag. If a release is defective:

- mark the GitHub release and notes prominently with the impact and mitigation;
- remove a dangerous downloadable asset when necessary while preserving an audit trail;
- publish a new patch version from a reviewed fix, with new tags, checksums, signing, and notarization;
- document workspace compatibility and whether users can safely return to an earlier build; and
- keep the last known-good artifact available only when it remains safe and its provenance can still be verified.

For a compromised artifact, dependency, token, or signing identity, stop publication, rotate exposed secrets, coordinate certificate or credential revocation with the relevant provider, invalidate affected downloads, and use the private security process. Tell users exactly which versions, architectures, hashes, or certificates are affected and how to verify a replacement.
