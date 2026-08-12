# Changelog

All notable changes to Odinn Forge will be documented in this file.

The format is based on Keep a Changelog, and releases use Semantic Versioning.

## [Unreleased]

### Added

* durable OCI jobs, child-agent graphs, skills, MCP, workflows, event ingress,
  project context, and the governed operator plane

### Fixed

* bound operator snapshots and expose independent operator attention totals
* add bounded approval effect summaries, explicit denial, and centralized
  credential redaction
* move audit state metadata and self-improvement defaults in line with the
  active SQLite and review-gated runtime
* separate routine dependency maintenance from Node and TypeScript major
  toolchain migrations during release-candidate stabilization

### Release engineering

* prepare the post-`v1.0.0` development line as `1.1.0-rc.1`
* require draft-release verification before immutable publication
* freeze the 1.1 candidate around boundary completion, defect repair,
  decomposition, and exact-artifact validation without promoting experimental
  interfaces

## [1.0.0](https://github.com/BlueDot-IT/Odinn-Forge/compare/v1.0.0-rc.1...v1.0.0) (2026-07-25)

### Changed

* promote the verified v1 release-candidate artifact structure and supported
  local, single-user compatibility contract to the stable release
* keep the release-candidate state schemas and runtime behavior unchanged so
  updating from `v1.0.0-rc.1` does not require a state migration

### Validation

* publish the same compiled archive layout verified by the release-candidate
  build, soak, migration, lifecycle, audit, and clean-install checks

## [1.0.0-rc.1](https://github.com/BlueDot-IT/Odinn-Forge/compare/v0.4.0...v1.0.0-rc.1) (2026-07-25)

### Added

* publish the v1 compatibility policy for the supported local, single-user
  workflow and clearly separate stable, experimental, provider-dependent,
  platform-dependent, internal, and unsupported behavior
* add safe user-facing update, rollback, backup, restore, uninstall, state
  status, and migration dry-run commands
* add a per-store schema registry, deterministic migration planner,
  backup-before-migration, crash recovery, future-schema refusal, and
  downgrade compatibility checks
* define first-class, compatible, experimental, and custom AI provider support
  labels for onboarding, diagnostics, and documentation
* build ZIP and tar.gz releases from compiled JavaScript with source maps and
  the pruned `playwright-core` runtime dependency

### Changed

* remove pnpm, Corepack, workspace installation, and TypeScript execution from
  the normal release installation path
* separate provider transport, public web policy, isolated browser execution,
  approvals, memory, workspace records, and bounded self-improvement from the
  central kernel entry module
* rewrite the README and normal installation guidance for everyday users,
  business owners, and independent professionals
* run the existing restart, recovery, audit, upgrade, and rollback soak against
  the assembled production archive

### Security

* require verified release identity and checksums before updates, reject unsafe
  archive paths and links, and preserve the current installation after a failed
  update or health check
* validate migration and restore input as untrusted data, keep temporary and
  backup files owner-only, reject state-root escapes, and fail closed on
  unknown schemas
* preserve private-network blocking, DNS pinning, redirect validation,
  isolated browser data, browser mutation approval, and uncertain-outcome
  recovery through the kernel decomposition
* replace polynomial memory-normalization expressions with linear-time scans
  after CodeQL identified denial-of-service risk

### Validation

* verify compiled archives install and run without pnpm or a source checkout
  on Linux, macOS, and Windows
* cover clean install, pre-v1 upgrade, migration failure and recovery, update,
  compatible and incompatible rollback, backup, restore, uninstall, audit
  integrity, and release-content equivalence
* generate and verify SHA-256 checksums, production SBOMs, release manifests,
  commit-bound provenance, and clean-install smoke evidence for the exact
  release archives

## [0.4.0](https://github.com/BlueDot-IT/Odinn-Forge/compare/v0.4.0-beta.3...v0.4.0) (2026-07-25)

### Added

* overhaul the daily-use console with clearer Projects, Sessions, Goals,
  automatic Memory, Activity, Cron Jobs, Tasks, package management, and
  dedicated Labs pages
* add a structured configuration editor for providers, authentication,
  permissions, web and browser safety, experimental features, automatic
  improvements, runtime behavior, Proof, and memory
* add durable maintainer review evidence while keeping repository automation
  proposal-only

### Fixed

* send ChatGPT and Codex OAuth system guidance through the expected
  `instructions` field
* patch the high-severity `brace-expansion` advisory in the locked dependency
  tree

### Security

* harden configuration writes against stale edits, unsafe state paths,
  symbolic links, hard links, oversized requests, and concurrent saves
* keep hosted-provider destinations and credentials isolated from
  tenant-controlled configuration
* preserve explicit approvals, loopback-only local defaults, owner-only state,
  and disabled-by-default third-party packages and experimental features

### Validation

* verify real OpenAI OAuth and OpenRouter API-key inference from the published
  beta.3 artifact without exposing credentials in configuration, diagnostics,
  audit output, or release evidence
* pass Linux, macOS, and Windows CI, package integrity, integration, inference,
  security, and install-smoke coverage on the stable code line

### Documentation

* replace internal release jargon with a plain-language README for everyday
  users and small business owners
* consolidate active operator, security, capability-boundary, release, and UAT
  documentation under evergreen names

## [0.4.0-beta.3](https://github.com/BlueDot-IT/Odinn-Forge/compare/v0.4.0-beta.2...v0.4.0-beta.3) (2026-07-23)

### Validation

* prepare the exact published candidate for Windows, live-provider, multi-user daily-use, and final stable-release validation
* verify real OpenAI OAuth and OpenRouter API-key inference paths without embedding credentials in configuration or diagnostic evidence
* retain the Windows, multi-user multi-day, and final maintainer go/no-go gates until their required external evidence is complete

### Documentation

* direct release-identity diagnostics to `odinn doctor`
* run the release soak before checksums so the soak report is included in verified release evidence

## [0.4.0-beta.2](https://github.com/BlueDot-IT/Odinn-Forge/compare/v0.4.0-beta.1...v0.4.0-beta.2) (2026-07-23)

### Fixed

* close one-shot CLI browser workers after direct and planned runs
* allow restoring browser approval without a dangerous-change confirmation
* extend provider verification for cold local-model starts
* preserve clean release version and commit metadata through install and rollback
* classify browser runtime failures without exposing internal diagnostics

### Security

* add reproducibly seeded property tests for malformed protocol input, nested secret redaction, denial preservation, and traversal-sensitive identifiers
* link private vulnerability reporting and define acknowledgment, status-update, and coordinated-disclosure targets
* record written dispositions for the five open OpenSSF Scorecard findings without claiming unresolved gaps are fixed

### Documentation

* separate verified beta behavior from incomplete stable-release evidence
* track Windows, live-provider, multi-user daily-use, and final security/go-no-go gates in the `v0.4.0 stable` milestone

## [0.4.0-beta.1](https://github.com/BlueDot-IT/Odinn-Forge/compare/v0.3.0-beta.3...v0.4.0-beta.1) (2026-07-21)

### Features

* add the Beta 4 stable-exit plan and validation matrix

### Security

* redact credential-like values from CLI failures
* stop browser proxy failures from exposing internal network errors
* scope release workflow permissions to the jobs that require them

### Build and CI

* cap local workspace, dependency lifecycle, and Node.js memory concurrency
* update pinned GitHub Actions and CodeQL tooling
* replace Release Please with an explicit reviewed version PR and operator-created tag

### Documentation

* document the resource-bounded development defaults and manual release procedure
* repair the Beta 3 changelog comparison link

## [0.3.0-beta.3](https://github.com/BlueDot-IT/Odinn-Forge/compare/v0.3.0-beta.1...v0.3.0-beta.3) (2026-07-18)


### Features

* add reader conversation recap ([cbf9be9](https://github.com/BlueDot-IT/Odinn-Forge/commit/cbf9be98932464f672fbd8767bd70ac1e8a5b217))
* **beta:** add durable memory agent runtime ([#13](https://github.com/BlueDot-IT/Odinn-Forge/issues/13)) ([787da82](https://github.com/BlueDot-IT/Odinn-Forge/commit/787da827e4575f5564fb2b41b3059577987dafeb))
* **beta:** close P0 runtime foundations ([#14](https://github.com/BlueDot-IT/Odinn-Forge/issues/14)) ([26152a5](https://github.com/BlueDot-IT/Odinn-Forge/commit/26152a56308703b78eaabe3dc6b771998e04872c))
* **beta:** finish execution and release ledger ([#15](https://github.com/BlueDot-IT/Odinn-Forge/issues/15)) ([37d6dce](https://github.com/BlueDot-IT/Odinn-Forge/commit/37d6dce064ffc7abc77bef66e7129c155e31b6a8))
* **cli:** make onboarding human-friendly ([1479600](https://github.com/BlueDot-IT/Odinn-Forge/commit/1479600ef9a7f35266484bea60c472e406880c20))
* **cli:** rebuild onboarding as a safe guided flow ([d9bca12](https://github.com/BlueDot-IT/Odinn-Forge/commit/d9bca128ae675d0b3800b6ed71d76a0327b5327e))
* complete beta 3 stabilization ([d269f5e](https://github.com/BlueDot-IT/Odinn-Forge/commit/d269f5e7408c2a342918656cf8cc40f8278d812e))
* complete beta runtime boundaries ([#19](https://github.com/BlueDot-IT/Odinn-Forge/issues/19)) ([6498555](https://github.com/BlueDot-IT/Odinn-Forge/commit/64985553d118473bd6266617a9597f96a5fdac14))
* **gateway:** improve activity and create agent manifests ([8519fbc](https://github.com/BlueDot-IT/Odinn-Forge/commit/8519fbca97f13543cbe8b79cba48fe3c518b40f9))
* polish console operations and scoped state ([f769a76](https://github.com/BlueDot-IT/Odinn-Forge/commit/f769a760d50c73734f3985e0bb1bfac101ac6a96))
* **runtime:** close counterfactual audit and browser gaps ([5dec2fb](https://github.com/BlueDot-IT/Odinn-Forge/commit/5dec2fb066976954aa33d7431b98c46a40e679b6))
* **runtime:** interpose extensions and replay capsules ([575e9ca](https://github.com/BlueDot-IT/Odinn-Forge/commit/575e9caa7bfc50f71af2ed170bdae6f2235c74c2))
* surface and verify experimental systems ([79713f3](https://github.com/BlueDot-IT/Odinn-Forge/commit/79713f303d82bbeda6a33e50e9638678d9f52722))
* **ui:** organize sidebar like OpenClaw ([25de8d6](https://github.com/BlueDot-IT/Odinn-Forge/commit/25de8d6521b30f1ab413ebe6c7968ae5f7636422))


### Bug Fixes

* align Codex OAuth request headers ([9d572b6](https://github.com/BlueDot-IT/Odinn-Forge/commit/9d572b603bfba005324206865ac0abc3922f90e9))
* **beta:** close security blockers and finish runtime ledger ([#18](https://github.com/BlueDot-IT/Odinn-Forge/issues/18)) ([32503bd](https://github.com/BlueDot-IT/Odinn-Forge/commit/32503bd1e254849ebf1a0dd9bb17d0fcdaf49a66))
* **beta:** stabilize browser worker and remove stale local model ([#17](https://github.com/BlueDot-IT/Odinn-Forge/issues/17)) ([20f6662](https://github.com/BlueDot-IT/Odinn-Forge/commit/20f666281bc8ab8a46363535bb949fba12a88b7c))
* **ci:** repair TypeScript release gates ([#23](https://github.com/BlueDot-IT/Odinn-Forge/issues/23)) ([6b4e942](https://github.com/BlueDot-IT/Odinn-Forge/commit/6b4e9425bcbd735945f1c40a1c15823f500763bb))
* **ci:** scope scorecard to default branch ([#36](https://github.com/BlueDot-IT/Odinn-Forge/issues/36)) ([1a18cb8](https://github.com/BlueDot-IT/Odinn-Forge/commit/1a18cb8a88160a1a81752e0258c1b8345999ff8e))
* **ci:** scope scorecard workflow environment ([#25](https://github.com/BlueDot-IT/Odinn-Forge/issues/25)) ([2c3cf9b](https://github.com/BlueDot-IT/Odinn-Forge/commit/2c3cf9b2bcef924024e4d478ba7fef660cb8117b))
* **cli:** expose advanced beta safety controls ([#38](https://github.com/BlueDot-IT/Odinn-Forge/issues/38)) ([4f8038c](https://github.com/BlueDot-IT/Odinn-Forge/commit/4f8038c00b1eaa0be8e63df4b969262eee756ea9))
* execute dotted tools over Codex transport ([12e0712](https://github.com/BlueDot-IT/Odinn-Forge/commit/12e0712e00cdc35fe6ef0039d9a954dbb2f01e9d))
* handle aborted soak requests ([ac818b3](https://github.com/BlueDot-IT/Odinn-Forge/commit/ac818b3c8182ec4e16ee623e6611177194459164))
* invoke Windows package manager safely ([0e2b7e7](https://github.com/BlueDot-IT/Odinn-Forge/commit/0e2b7e7d62778a26b9df6c486a6755edaa4d323f))
* keep release soak provider responsive ([8f95c19](https://github.com/BlueDot-IT/Odinn-Forge/commit/8f95c194d5a5ea38188e2285e96b4291b50fc355))
* make onboarding smoke Windows-safe ([45d321d](https://github.com/BlueDot-IT/Odinn-Forge/commit/45d321dd67487305498a08273db0e8a4b9129290))
* redact release soak evidence ([1d9d685](https://github.com/BlueDot-IT/Odinn-Forge/commit/1d9d685ea2b67f34e9a8c0520023b18e1b6216c0))
* **release:** align security docs and enforcement ([#26](https://github.com/BlueDot-IT/Odinn-Forge/issues/26)) ([1a6802f](https://github.com/BlueDot-IT/Odinn-Forge/commit/1a6802f2570558b90e517fdee1e9740fb9f452f1))
* **release:** run checks for generated pull requests ([#32](https://github.com/BlueDot-IT/Odinn-Forge/issues/32)) ([1767488](https://github.com/BlueDot-IT/Odinn-Forge/commit/1767488a3f7724a7fab734372a0852039d1e44d9))
* **release:** target repository for workflow dispatch ([#34](https://github.com/BlueDot-IT/Odinn-Forge/issues/34)) ([a861b56](https://github.com/BlueDot-IT/Odinn-Forge/commit/a861b567f597fbee41d6f44e3e1540d13dcfdd13))
* **repo:** support user-owned branch protection ([#28](https://github.com/BlueDot-IT/Odinn-Forge/issues/28)) ([6d42067](https://github.com/BlueDot-IT/Odinn-Forge/commit/6d42067877bf3ac96db475a4db29f0b1ec70e110))
* resolve pnpm shim on Windows ([414292c](https://github.com/BlueDot-IT/Odinn-Forge/commit/414292cc0b23fd8e84841eaf150169ec05a6b4d0))
* restore public beta model and web execution ([9ced00d](https://github.com/BlueDot-IT/Odinn-Forge/commit/9ced00d6d66b40d45c0bb46f7c04bf71873e8352))
* stabilize packaged benchmark harness ([e2b97ec](https://github.com/BlueDot-IT/Odinn-Forge/commit/e2b97ecf03da4092b72f66df15bad4cc04078942))
* **test:** make browser SSRF proof deterministic ([#40](https://github.com/BlueDot-IT/Odinn-Forge/issues/40)) ([bd02875](https://github.com/BlueDot-IT/Odinn-Forge/commit/bd02875fd51915f2992f7725e317464fffe6dd96))
* use distinct release identity in soak ([f5ac11f](https://github.com/BlueDot-IT/Odinn-Forge/commit/f5ac11fcc877fbece5a06cffa3138f0bb9ccc272))
* use valid synthetic soak version ([e7552e1](https://github.com/BlueDot-IT/Odinn-Forge/commit/e7552e16573735fbd5358cbbcbb6b5a359d993cd))

## [0.3.0-beta.1](https://github.com/BlueDot-IT/Odinn-Forge/compare/v0.2.1-beta.1...v0.3.0-beta.1) (2026-07-16)


### Features

* **gateway:** improve activity and create agent manifests ([8519fbc](https://github.com/BlueDot-IT/Odinn-Forge/commit/8519fbca97f13543cbe8b79cba48fe3c518b40f9))


### Bug Fixes

* restore public beta model and web execution ([9ced00d](https://github.com/BlueDot-IT/Odinn-Forge/commit/9ced00d6d66b40d45c0bb46f7c04bf71873e8352))

## [0.2.1-beta.1](https://github.com/BlueDot-IT/Odinn-Forge/compare/v0.2.1-beta...v0.2.1-beta.1) (2026-07-16)


### Bug Fixes

* **cli:** expose advanced beta safety controls ([#38](https://github.com/BlueDot-IT/Odinn-Forge/issues/38)) ([4f8038c](https://github.com/BlueDot-IT/Odinn-Forge/commit/4f8038c00b1eaa0be8e63df4b969262eee756ea9))
* **test:** make browser SSRF proof deterministic ([#40](https://github.com/BlueDot-IT/Odinn-Forge/issues/40)) ([bd02875](https://github.com/BlueDot-IT/Odinn-Forge/commit/bd02875fd51915f2992f7725e317464fffe6dd96))

## [0.2.1-beta](https://github.com/BlueDot-IT/Odinn-Forge/compare/v0.2.0...v0.2.1-beta) (2026-07-16)


### Bug Fixes

* **ci:** scope scorecard to default branch ([#36](https://github.com/BlueDot-IT/Odinn-Forge/issues/36)) ([1a18cb8](https://github.com/BlueDot-IT/Odinn-Forge/commit/1a18cb8a88160a1a81752e0258c1b8345999ff8e))
* **release:** align security docs and enforcement ([#26](https://github.com/BlueDot-IT/Odinn-Forge/issues/26)) ([1a6802f](https://github.com/BlueDot-IT/Odinn-Forge/commit/1a6802f2570558b90e517fdee1e9740fb9f452f1))
* **release:** run checks for generated pull requests ([#32](https://github.com/BlueDot-IT/Odinn-Forge/issues/32)) ([1767488](https://github.com/BlueDot-IT/Odinn-Forge/commit/1767488a3f7724a7fab734372a0852039d1e44d9))
* **release:** target repository for workflow dispatch ([#34](https://github.com/BlueDot-IT/Odinn-Forge/issues/34)) ([a861b56](https://github.com/BlueDot-IT/Odinn-Forge/commit/a861b567f597fbee41d6f44e3e1540d13dcfdd13))
* **repo:** support user-owned branch protection ([#28](https://github.com/BlueDot-IT/Odinn-Forge/issues/28)) ([6d42067](https://github.com/BlueDot-IT/Odinn-Forge/commit/6d42067877bf3ac96db475a4db29f0b1ec70e110))

## [0.2.0](https://github.com/BlueDot-IT/Odinn-Forge/compare/v0.1.0...v0.2.0) (2026-07-16)


### Features

* **beta:** add durable memory agent runtime ([#13](https://github.com/BlueDot-IT/Odinn-Forge/issues/13)) ([787da82](https://github.com/BlueDot-IT/Odinn-Forge/commit/787da827e4575f5564fb2b41b3059577987dafeb))
* **beta:** close P0 runtime foundations ([#14](https://github.com/BlueDot-IT/Odinn-Forge/issues/14)) ([26152a5](https://github.com/BlueDot-IT/Odinn-Forge/commit/26152a56308703b78eaabe3dc6b771998e04872c))
* **beta:** finish execution and release ledger ([#15](https://github.com/BlueDot-IT/Odinn-Forge/issues/15)) ([37d6dce](https://github.com/BlueDot-IT/Odinn-Forge/commit/37d6dce064ffc7abc77bef66e7129c155e31b6a8))
* complete beta runtime boundaries ([#19](https://github.com/BlueDot-IT/Odinn-Forge/issues/19)) ([6498555](https://github.com/BlueDot-IT/Odinn-Forge/commit/64985553d118473bd6266617a9597f96a5fdac14))
* **runtime:** close counterfactual audit and browser gaps ([5dec2fb](https://github.com/BlueDot-IT/Odinn-Forge/commit/5dec2fb066976954aa33d7431b98c46a40e679b6))
* **runtime:** interpose extensions and replay capsules ([575e9ca](https://github.com/BlueDot-IT/Odinn-Forge/commit/575e9caa7bfc50f71af2ed170bdae6f2235c74c2))
* **ui:** organize sidebar like OpenClaw ([25de8d6](https://github.com/BlueDot-IT/Odinn-Forge/commit/25de8d6521b30f1ab413ebe6c7968ae5f7636422))


### Bug Fixes

* **beta:** close security blockers and finish runtime ledger ([#18](https://github.com/BlueDot-IT/Odinn-Forge/issues/18)) ([32503bd](https://github.com/BlueDot-IT/Odinn-Forge/commit/32503bd1e254849ebf1a0dd9bb17d0fcdaf49a66))
* **beta:** stabilize browser worker and remove stale local model ([#17](https://github.com/BlueDot-IT/Odinn-Forge/issues/17)) ([20f6662](https://github.com/BlueDot-IT/Odinn-Forge/commit/20f666281bc8ab8a46363535bb949fba12a88b7c))
* **ci:** repair TypeScript release gates ([#23](https://github.com/BlueDot-IT/Odinn-Forge/issues/23)) ([6b4e942](https://github.com/BlueDot-IT/Odinn-Forge/commit/6b4e9425bcbd735945f1c40a1c15823f500763bb))
* **ci:** scope scorecard workflow environment ([#25](https://github.com/BlueDot-IT/Odinn-Forge/issues/25)) ([2c3cf9b](https://github.com/BlueDot-IT/Odinn-Forge/commit/2c3cf9b2bcef924024e4d478ba7fef660cb8117b))
