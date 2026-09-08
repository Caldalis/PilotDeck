# Settings redesign integration

This branch integrates the net changes from PR #557 (`22c81f8f`) on top of
`upstream/main` (`12ed4a21`), preserving the redesigned settings routes and simpler
controls. The original PR branch is not rewritten.

## Permission preference

The chat composer's **Default Permissions / Full Access** picker owns one global
preference, persisted through `/api/settings/permissions` in the active PilotDeck
home's `permissions.json`:

- `skipPermissions: true` selects Full Access; `false` selects Default Permissions.
- Projects and sessions share the latest saved choice. Legacy browser session
  preferences are ignored. A fresh application reads the server preference.
- Opening Security & Privacy does not write this preference. That page edits tool
  rules and telemetry. Existing allow, ask and deny rules are retained.
- Loading/saving failures block new submissions and provide a retry. Manual writes
  are serialized; failed writes roll back the displayed choice.
- Plan mode remains a per-turn override. Submitted and queued turns retain their
  captured permission mode; changing the preference affects subsequent requests.
- Other windows refresh from the server on the preference storage signal or focus.

## Integration fixes

- The redesigned About page uses main's Release schema and Electron IPC update
  service, retaining clean-Git eligibility, disabled reasons, progress polling,
  interrupted-stream recovery and restart handling.
- Settings CSS is scoped to its layout and notification container, including dark
  and responsive rules, so common class names do not style the chat/onboarding UI.
- Retry settings show their target provider and keep the redesign's primary-model
  provider scope. Switching providers clears an unsaved retry draft. Saving retries
  no longer creates an incomplete, enabled token-saver configuration. A separately
  edited judge timeout keeps an unconfigured token saver disabled.
- Two pre-existing type errors in the redesign were corrected without changing the
  resident-task or model-deletion interactions.

## Model pool behavior

- Provider badges describe configuration completeness: **Configured** when required
  connection fields and models are present, **Pending** when they are missing.
  Connection testing is optional, including when selecting the primary model.
- Provider IDs retain their exact spelling through credential lookup, connection
  tests, saves and model references. Catalog aliases only choose default settings;
  they never rename the stored provider. Custom display names also retain their case. `HXAPI` and `hxapi` remain separate keys.
- A successful probe is shown as healthy only after its result is saved. Save
  failures offer a retry using the same test record, without another model probe,
  or a fresh test if the record has expired. Credential and endpoint matching,
  record ownership/expiry checks and model-reference validation remain enforced.

## Connection test tasks

- The server owns each user's running connection test, including saving and manual
  image confirmation. The settings card polls its status; switching providers,
  leaving settings, or refreshing the browser does not stop the task or lose it.
- Test buttons are disabled while reading status, submitting, testing, confirming
  image capabilities, cancelling or saving. Other providers identify the active
  provider. Cancellation aborts the probe and releases the slot after it settles.
- Successful results bind to the latest on-disk config under the config write lock.
  Unrelated edits are preserved; changed credentials/endpoints or removed models
  reject the binding. A failed save can retry without another probe.
- Task snapshots are scoped to the authenticated user and contain no credentials.
  Terminal results are retained in memory for one hour; pending manual confirmation
  and failed-save records expire after ten minutes. Restarting the backend ends
  in-memory tasks. Browser refresh reconnects to the still-running backend task.
- Chromium checks cover provider/page switching, refresh, completion with settings
  closed, grey disabled test buttons, save-failure recovery, cancellation and manual
  image confirmation across navigation.

## Validation

- Web Regression's local suite: **168 files, 1,363 tests passed** with the same
  existing CI exclusions for Playwright E2E, streamSmoother and desktop network tests.
- The final local run hit one transient loopback `ECONNRESET` in the unchanged
  cron route suite; its 14 tests passed on a focused rerun.
- Desktop packaging helper tests: **41 passed**; desktop updater network tests passed.
- Permission settings and router parsing tests: **8 passed**.
- UI type checking, Gateway/Web production builds and Electron TypeScript compile passed.
- Real Chromium against an isolated PilotDeck home and ports: all **14 settings
  routes** loaded without page errors; permission changes survived refresh and
  privacy navigation; tool rule additions/removals preserved full access and deny
  rules; retry changes saved through the config API without changing another
  provider. Dark/390px mobile layouts and returning to chat were checked. A probe
  outside settings retained identical computed styles with/without settings CSS.

- Model-pool regression in Chromium against a local mock model endpoint: complete
  untested providers display as configured; masked-key tests save and survive a
  reload without changing either case-sensitive provider key; a failed result save
  retries without another model request; an untested primary model saves directly.

These checks do not perform a signed macOS or Windows cross-version installer
upgrade. The integration preserves main's updater rather than changing packaging.
