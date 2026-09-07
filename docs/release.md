# PilotDeck releases and desktop builds

PilotDeck keeps Web and desktop sources on `main`. The desktop application is a
thin Electron shell around the same gateway and Web UI; desktop-specific runtime
behavior is enabled only when Electron sets `PILOTDECK_DESKTOP=1`.

## Web compatibility

- The existing root and `ui` build commands remain the source of the Web build.
- Docker installs only the root and UI workspace dependencies, so Electron and
  its native packaging dependencies are not installed in the Web image.
- Browser deployments never receive the Electron preload bridge.
- Desktop runtime files live under `apps/desktop` and are ignored by the Docker
  build context.
- Desktop runtime production dependencies use the dedicated manifest and frozen
  lockfile under `apps/desktop/runtime`; Web installs do not include this package.

Pull requests that touch shared, UI, Docker, or desktop code run the Web
regression workflow. Desktop-related pull requests also compile and test the
desktop shell.

The Web test job temporarily excludes `ui/e2e/**` (Playwright tests are not
Vitest tests) and the upstream `streamSmoother.test.ts` fake-timer test. Both are
known baseline failures; all other UI/server tests remain in the merge gate.

## Daily release policy

`.github/workflows/release.yml` runs every day at 02:00 Asia/Shanghai
(18:00 UTC on the previous calendar day). It compares `main` with the commit in
the latest unified release tag:

- no production change: skip the release;
- production change: build signed and notarized macOS arm64 and x64 installers
  plus an unsigned Windows installer, then publish one dated GitHub Release;
- repeated manual release on the same date: use `-r2`, `-r3`, and so on.

Release names and tags are `vYYYY.MM.DD`, for example `v2026.09.07`.
Additional releases on that date use `v2026.09.07-r2`, `-r3`, and so on.
The internal Electron version remains a numeric SemVer derived from the same
Shanghai date: `v2026.09.07` maps to `2026.907.0`, and `-r2` maps to
`2026.907.1`. GitHub Actions may also be started manually with an optional
zero-based release revision. An explicitly requested existing tag is rejected.

Each release shares one exact `main` commit across the tag, desktop installers,
and Web source code:

- Assets: macOS arm64 and x64 DMGs, the Windows installer, `release.json`, and
  `SHA256SUMS.txt`.
- Web source: GitHub's automatically provided **Source code (zip)** and
  **Source code (tar.gz)** archives for the release tag. No separate Web archive
  or prebuilt deployment package is uploaded; source deployments still install
  dependencies and build the application.
- `release.json`: the numeric version, tag, release date, metadata generation
  time (`buildTime`), source commit (`sourceSha`), repository, and installer
  sizes, platforms, architectures, and SHA-256 checksums. `SHA256SUMS.txt`
  covers the uploaded installers, not GitHub-generated source archives.

Release detection considers Web, Gateway, desktop, shared runtime, and Docker
files. Changes limited to `docs/` or root README files skip the release unless
`force` is enabled.
Only the new `vYYYY.MM.DD[-rN]` tags are considered; historical `desktop-v` tags
are not used as a baseline, so the first unified release builds automatically.

Build scripts use `PILOTDECK_RELEASE_DATE`, `PILOTDECK_RELEASE_REVISION`,
`PILOTDECK_RELEASE_VERSION`, `PILOTDECK_RELEASE_TAG`, and
`PILOTDECK_RELEASE_BUILD_TIME` for release metadata. Desktop runtime environment
variables remain separate from these build-time inputs.

Publishing and packaged repository metadata use the repository running the
workflow. Upstream builds publish to `OpenBMB/PilotDeck`; fork builds publish to
their own repository.

This phase changes packaging and publishing only. The Web and desktop in-app
update flows have not yet been migrated to the unified release tags; that
integration is a separate follow-up.

## Required GitHub Secrets

Release builds deliberately fail when macOS code signing or notarization is
unavailable. Windows packaging remains explicitly unsigned, matching the
existing `desktopdev` release behavior.

macOS:

- `MACOS_DEVELOPER_ID_APPLICATION_P12_BASE64`
- `MACOS_DEVELOPER_ID_APPLICATION_PASSWORD`
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`
- `MACOS_KEYCHAIN_PASSWORD` (optional)

The macOS jobs run in parallel on GitHub's Apple Silicon `macos-latest` and
Intel `macos-15-intel` images. Each job fails early when the runner architecture
does not match its installer, and verifies the Electron executable, bundled
Node.js, and native runtime modules before uploading the DMG.

The macOS certificate must be a Developer ID Application certificate. The
Windows installer does not require a signing certificate. GitHub's automatic
`GITHUB_TOKEN` is used to publish the Release.

## Manual builds

```bash
pnpm install --frozen-lockfile
pnpm --filter pilotdeck-desktop test
# Run the command matching the Mac host architecture:
pnpm --filter pilotdeck-desktop dist:mac:arm64
pnpm --filter pilotdeck-desktop dist:mac:x64
# Run the following on Windows:
pnpm --filter pilotdeck-desktop dist:win
```

Local macOS builds can use ad-hoc signing. Set
`PILOTDECK_DESKTOP_REQUIRE_SIGNING=1` to enforce production signing locally.

When a root or UI dependency used by the desktop runtime changes, update
`apps/desktop/runtime/package.json`, then refresh its dedicated lockfile with:

```bash
pnpm --dir apps/desktop/runtime install --lockfile-only --ignore-workspace
```

The desktop build fails if the runtime manifest no longer matches the root and
UI manifests, or if its committed lockfile is stale.

## Recovery

If one architecture or platform fails, fix the credential or build issue and
rerun the failed workflow. A release is created only after both macOS DMGs and
the Windows installer are downloaded and verified. For a deliberate additional
release on the same Shanghai date, leave revision empty to select the next
available `-rN` tag automatically.
