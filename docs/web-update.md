# Web self-update

Web self-update is a convenience for standard Git deployments. It installs the
latest stable `vYYYY.MM.DD[-rN]` release from `OpenBMB/PilotDeck`, using the
release manifest's `sourceSha` and verifying that it matches the published tag.
It does not follow the moving tip of `main`.

## Supported deployments

The checkout must be a full, standalone Git clone on `main`, with an official
GitHub remote and no modified, staged, or untracked files. The running build
must come from clean source and match the checkout and build files on disk.
Node 22 and pnpm must be available for installation and building.

Development mode, custom branches, detached HEADs, linked worktrees, local
changes, custom/diverged/ahead commits, shallow clones, Docker, and source
archives do not support the update button. The About page disables it and
explains why. These deployments continue to use their normal manual update
process. Automatic downgrades and Git conflict resolution are not supported.

## Build and running versions

Build both parts before starting a production deployment:

```sh
pnpm install --frozen-lockfile --filter pilotdeck --filter pilotdeck-ui
pnpm run build:web
pnpm --dir ui run start:built
```

The Gateway and UI build hooks each write `web-build.json` in their own `dist`
directory. These record the source SHA, a release tag if known, whether the
source was clean, and the build time. Both builds must identify the same commit.
The server reads the metadata once at startup. Pulling code or rebuilding while
the server is running does not change its reported running version. Missing or
inconsistent metadata disables self-update; rebuild and restart manually.

## Update process

1. Opening settings checks deployment eligibility and queries the latest stable
   unified release. Equal commits report up-to-date. Only an ancestor of the
   release commit may update; ahead/diverged histories require manual handling.
2. Clicking Update submits the exact displayed tag and SHA. The server checks
   eligibility, the release target and an update lock again. A changed target
   requires a fresh check instead of silently installing a different release.
3. The server clones the selected commit into a temporary directory under `.git`,
   installs frozen dependencies and builds both Gateway and UI there. Failures
   during preparation leave the original checkout and artifacts in place.
4. It rechecks the checkout after building, transfers the prepared dependencies
   and build outputs, and fast-forwards `main` to the release commit. It does
   not stash changes or run `git reset --hard`. If that transfer or fast-forward
   fails, it attempts to restore the previous artifacts.
5. The page offers Restart to apply. The existing restart confirmation flow
   waits for a new service instance before reloading the page.

The update is not an atomic deployment across a process crash or power failure,
and it does not roll back databases/configuration after a new version starts.
If restoring artifacts fails, backups and the update lock remain under `.git`;
the server log identifies the backup directory for manual recovery. Do not remove
an update lock while another updater is running.

Preparation progress and failures are logged with `[web-update]`. In-process
status allows the About page to recover an active update or pending restart
when reopened. `scripts/update.sh` uses the same eligibility checks and staged
update implementation; it requires a manual service restart on completion.
