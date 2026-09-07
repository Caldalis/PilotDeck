import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authenticatedFetch } from "../../../../utils/api";
import AboutSections from ".";
import type { DesktopVersionCheckResult } from "../../Settings";
vi.mock("../../../../utils/api", () => ({ authenticatedFetch: vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const request = vi.mocked(authenticatedFetch);
const copy = (key: string) => `settingsPage.about.desktopUpdate.${key}`;
const response = (data: unknown, ok = true) => ({ ok, json: async () => data }) as Response;
const completed = { state: "downloaded", verified: true, filePath: "/verified.dmg", release: { tagName: "v2026.09.07" } };
function show(props: Partial<DesktopVersionCheckResult> = {}) {
  return render(<AboutSections title="About" checkingVersion={false} versionInfo={{
    mode: "desktop", currentVersion: "2026.906.0", latestVersion: "2026.907.0", latestPublishedAt: null,
    hasUpdate: true, canDownload: true, checkUnavailable: false, buildTime: null, ...props,
  }} />);
}
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const tick = () => act(async () => { await vi.advanceTimersByTimeAsync(1000); });
beforeEach(() => request.mockReset());
afterEach(() => { cleanup(); vi.clearAllTimers(); vi.useRealTimers(); });
describe('desktop About updates', () => {
  it.each([
    { canDownload: false, desktopReason: 'noCompatibleInstaller' },
    { canDownload: false, hasUpdate: false },
    { canDownload: false, checkUnavailable: true, desktopReason: 'checkFailed' },
  ])('disables unavailable downloads', async (props) => {
    request.mockResolvedValue(response({ download: { state: "idle" } })); show(props); await flush();
    const button = screen.getByRole('button', { name: copy('download') }) as HTMLButtonElement;
    expect(button.disabled).toBe(true); fireEvent.click(button); expect(request).toHaveBeenCalledTimes(1);
    if (props.desktopReason) expect(screen.getByRole('alert').textContent).toBe(copy(`reasons.${props.desktopReason}`));
  });
  it('restores a verified installer and opens it only after a separate click', async () => {
    request.mockResolvedValueOnce(response({ download: completed })).mockResolvedValueOnce(response({ launched: true }));
    show(); await flush();
    expect(request).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: copy('install') })); await flush();
    expect(request).toHaveBeenLastCalledWith('/api/update/desktop/install', expect.objectContaining({ body: JSON.stringify({ filePath: '/verified.dmg' }) }));
    expect(screen.getByRole('status').textContent).toBe(copy('status.installerLaunched'));
    expect(screen.getByText(copy('reasons.installerLaunched'))).toBeTruthy();
  });
  it('never offers installation of an unverified download', async () => {
    request.mockResolvedValue(response({ download: { ...completed, verified: false } })); show(); await flush();
    expect(screen.queryByRole('button', { name: copy('install') })).toBeNull();
  });
  it('downloads first, recovers progress and requires another click to install', async () => {
    vi.useFakeTimers();
    let job = { state: 'idle' } as Record<string, unknown>;
    request.mockImplementation(async (url) => {
      if (url === '/api/update/desktop/download') job = { state: 'downloading', progress: .42 };
      return response({ download: job });
    });
    show(); await flush(); fireEvent.click(screen.getByRole('button', { name: copy('download') })); await flush();
    expect(screen.getByRole('progressbar').getAttribute('value')).toBe('42');
    job = completed; await tick();
    expect(screen.getByRole('button', { name: copy('install') })).toBeTruthy();
    expect(request.mock.calls.some(([url]) => url === '/api/update/desktop/install')).toBe(false);
  });
  it('recovers an active download after reopening and survives a polling failure', async () => {
    vi.useFakeTimers();
    request.mockResolvedValue(response({ download: { state: 'downloading', progress: .5 } }));
    const view = show(); await flush();
    expect(screen.getByText('50%')).toBeTruthy();
    request.mockRejectedValueOnce(new Error('temporary')); await tick();
    expect(screen.getByRole('alert').textContent).toBe(copy('reasons.statusFailed'));
    request.mockResolvedValue(response({ download: completed })); await tick();
    expect(screen.getByRole('button', { name: copy('install') })).toBeTruthy();
    view.unmount(); const count = request.mock.calls.length; await tick(); expect(request).toHaveBeenCalledTimes(count);
  });
  it('keeps download disabled while initial status is unknown and retries', async () => {
    vi.useFakeTimers(); request.mockRejectedValueOnce(new Error('network')).mockResolvedValue(response({ download: { state: 'idle' } }));
    show(); await flush();
    expect((screen.getByRole('button', { name: copy('download') }) as HTMLButtonElement).disabled).toBe(true);
    await tick(); expect((screen.getByRole('button', { name: copy('download') }) as HTMLButtonElement).disabled).toBe(false);
  });
  it('shows checksum failure and lets the user download again', async () => {
    request.mockResolvedValueOnce(response({ download: completed }))
      .mockResolvedValueOnce(response({ reason: 'checksumMismatch' }, false))
      .mockResolvedValue(response({ download: { state: 'failed', reason: 'checksumMismatch', verified: false } }));
    show(); await flush(); fireEvent.click(screen.getByRole('button', { name: copy('install') })); await flush();
    expect(screen.getByRole('alert').textContent).toBe(copy('reasons.checksumMismatch'));
    expect((screen.getByRole('button', { name: copy('download') }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(copy('status.installerLaunched'))).toBeNull();
  });
  it('keeps the install action available after an OS launch failure', async () => {
    request.mockResolvedValueOnce(response({ download: completed })).mockResolvedValueOnce(response({ reason: 'installFailed' }, false))
      .mockResolvedValue(response({ download: completed }));
    show(); await flush(); fireEvent.click(screen.getByRole('button', { name: copy('install') })); await flush();
    expect(screen.getByRole('alert').textContent).toBe(copy('reasons.installFailed'));
    expect((screen.getByRole('button', { name: copy('install') }) as HTMLButtonElement).disabled).toBe(false);
  });
  it('cancels through the server and offers a fresh download', async () => {
    request.mockImplementation(async (url) => response({ download: url === '/api/update/desktop/download/cancel'
      ? { state: 'cancelled', reason: 'cancelled' } : { state: 'downloading', progress: .3 } }));
    show(); await flush(); fireEvent.click(screen.getByRole('button', { name: copy('cancel') })); await flush();
    expect(screen.getByRole('alert').textContent).toBe(copy('reasons.cancelled'));
    expect((screen.getByRole('button', { name: copy('download') }) as HTMLButtonElement).disabled).toBe(false);
  });
});
