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

## Validation

- Web Regression's local suite: **164 files, 1,340 tests passed** with the same
  existing CI exclusions for Playwright E2E, streamSmoother and desktop network tests.
- Desktop packaging helper tests: **41 passed**; desktop updater network tests passed.
- Permission settings and router parsing tests: **8 passed**.
- UI type checking, Gateway/Web production builds and Electron TypeScript compile passed.
- Real Chromium against an isolated PilotDeck home and ports: all **14 settings
  routes** loaded without page errors; permission changes survived refresh and
  privacy navigation; tool rule additions/removals preserved full access and deny
  rules; retry changes saved through the config API without changing another
  provider. Dark/390px mobile layouts and returning to chat were checked. A probe
  outside settings retained identical computed styles with/without settings CSS.

These checks do not perform a signed macOS or Windows cross-version installer
upgrade. The integration preserves main's updater rather than changing packaging.
