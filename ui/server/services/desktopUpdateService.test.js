// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, realpath, rm, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDesktopUpdateService, openInstallerFile, selectDesktopAsset } from './desktopUpdateService.js';

const contents = Buffer.from('verified installer fixture');
const hash = createHash('sha256').update(contents).digest('hex');
const asset = (platform, arch) => ({ name: `PilotDeck-${platform}-${arch}${platform === 'darwin' ? '.dmg' : '-setup.exe'}`,
  platform, arch, size: contents.length, sha256: hash, downloadUrl: 'https://github.com/installer' });
const release = { tagName: 'v2026.09.07-r2', version: '2026.907.1', assets: [asset('darwin', 'arm64'), asset('darwin', 'x64'), asset('win32', 'x64')] };
const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
async function setup(options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pilotdeck-desktop-test-'));
  directories.push(directory);
  const openInstaller = vi.fn();
  const service = createDesktopUpdateService({ platform: 'darwin', arch: 'arm64',
    env: { PILOTDECK_DESKTOP: '1', PILOTDECK_DESKTOP_VERSION: '2026.907.0', PILOTDECK_UPDATE_CACHE_DIR: directory },
    latestRelease: async () => structuredClone(release), fetchImpl: async () => new Response(contents), openInstaller, ...options });
  return { service, directory, openInstaller };
}

describe('desktop release policy', () => {
  it.each([['darwin', 'arm64'], ['darwin', 'x64'], ['win32', 'x64']])('matches %s %s exactly', (platform, arch) => {
    expect(selectDesktopAsset(release, { platform, arch })).toEqual(asset(platform, arch));
  });
  it('never guesses another architecture, a portable EXE or ambiguous asset', () => {
    expect(selectDesktopAsset({ assets: [asset('darwin', 'x64')] }, { platform: 'darwin', arch: 'arm64' })).toBeNull();
    expect(selectDesktopAsset(release, { platform: 'win32', arch: 'arm64' })).toBeNull();
    expect(selectDesktopAsset({ assets: [asset('darwin', 'arm64'), asset('darwin', 'arm64')] }, { platform: 'darwin', arch: 'arm64' })).toBeNull();
    expect(selectDesktopAsset({ assets: [{ ...asset('win32', 'x64'), name: 'PilotDeck-portable.exe' }] }, { platform: 'win32', arch: 'x64' })).toBeNull();
  });
  it.each(['2026.907.1', '2026.908.0'])('does not offer equal versions or downgrades from %s', async (version) => {
    const { service } = await setup({ env: { PILOTDECK_DESKTOP_VERSION: version } });
    expect(await service.check()).toMatchObject({ hasUpdate: false, canDownload: false, checkUnavailable: false });
    await expect(service.startDownload()).rejects.toMatchObject({ reason: 'upToDate' });
  });
  it('shows a newer version but disables download when its installer is missing', async () => {
    const { service } = await setup({ latestRelease: async () => ({ ...release, assets: [] }) });
    expect(await service.check()).toMatchObject({ hasUpdate: true, canDownload: false, reason: 'noCompatibleInstaller' });
    await expect(service.startDownload()).rejects.toMatchObject({ reason: 'noCompatibleInstaller' });
  });
  it.each([{}, { PILOTDECK_DESKTOP_VERSION: 'development' }])('disables unknown or non-desktop runtimes', async (env) => {
    const { service } = await setup({ env });
    expect(await service.check()).toMatchObject({ canDownload: false, checkUnavailable: true });
  });
  it('uses the configured repository and clears stale success after a failed check', async () => {
    const latestRelease = vi.fn().mockResolvedValueOnce(release).mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(release);
    const { service } = await setup({ env: { PILOTDECK_DESKTOP_VERSION: '2026.907.0', PILOTDECK_UPDATE_REPOSITORY: 'example/PilotDeck' }, latestRelease });
    expect(await service.check()).toMatchObject({ canDownload: true });
    expect(await service.check()).toMatchObject({ cached: true });
    expect(await service.check({ force: true })).toMatchObject({ checkUnavailable: true });
    expect(await service.check()).toMatchObject({ canDownload: true });
    expect(latestRelease).toHaveBeenCalledTimes(3);
    expect(latestRelease).toHaveBeenCalledWith({ repository: 'example/PilotDeck' });
  });
});

describe('verified desktop download and installation', () => {
  it('downloads, verifies and opens only the completed installer', async () => {
    const { service, openInstaller } = await setup();
    expect(await service.startDownload()).toMatchObject({ state: 'downloading', verified: false });
    await service.waitForDownload();
    const job = service.status();
    expect(job).toMatchObject({ state: 'downloaded', verified: true, progress: 1, receivedBytes: contents.length });
    expect(await readFile(job.filePath)).toEqual(contents);
    expect(openInstaller).not.toHaveBeenCalled();
    await expect(service.install()).resolves.toMatchObject({ launched: true });
    expect(openInstaller).toHaveBeenCalledWith(await realpath(job.filePath));
    expect(service.status().state).toBe('installerLaunched');
  });
  it.each([Buffer.from('bad'), Buffer.alloc(contents.length, 0), Buffer.alloc(contents.length + 1, 0)])('rejects corrupt, truncated and oversized downloads', async (body) => {
    const { service, directory, openInstaller } = await setup({ fetchImpl: async () => new Response(body) });
    await service.startDownload();
    await service.waitForDownload();
    expect(service.status()).toMatchObject({ state: 'failed', reason: 'checksumMismatch', verified: false });
    expect(await readdir(directory)).toEqual([]);
    await expect(service.install()).rejects.toMatchObject({ reason: 'notVerified' });
    expect(openInstaller).not.toHaveBeenCalled();
  });
  it('rechecks the hash before installation and refuses a tampered file', async () => {
    const { service, openInstaller } = await setup();
    await service.startDownload(); await service.waitForDownload();
    await writeFile(service.status().filePath, Buffer.alloc(contents.length, 0));
    await expect(service.install()).rejects.toMatchObject({ reason: 'checksumMismatch' });
    expect(service.status()).toMatchObject({ state: 'failed', verified: false });
    expect(openInstaller).not.toHaveBeenCalled();
  });
  it('refuses arbitrary paths and symlinks outside the update cache', async () => {
    const { service, directory, openInstaller } = await setup();
    await service.startDownload(); await service.waitForDownload();
    await expect(service.install({ filePath: '/tmp/unrelated.exe' })).rejects.toMatchObject({ reason: 'notVerified' });
    const outside = await mkdtemp(path.join(os.tmpdir(), 'pilotdeck-other-test-')); directories.push(outside);
    const externalFile = path.join(outside, 'installer.dmg'); await writeFile(externalFile, contents);
    const file = service.status().filePath; await rm(file); await symlink(externalFile, file);
    await expect(service.install()).rejects.toMatchObject({ reason: 'notVerified' });
    expect(openInstaller).not.toHaveBeenCalled();
    expect(await readdir(directory)).toHaveLength(1);
  });
  it('reports launch errors without claiming success and allows retry', async () => {
    const openInstaller = vi.fn().mockRejectedValueOnce(new Error('OS refused')).mockResolvedValueOnce(undefined);
    const { service } = await setup({ openInstaller });
    await service.startDownload(); await service.waitForDownload();
    await expect(service.install()).rejects.toMatchObject({ reason: 'installFailed' });
    expect(service.status().state).toBe('downloaded');
    await expect(service.install()).resolves.toMatchObject({ launched: true });
  });
  it('locks before release checking and handles cancellation during that check', async () => {
    let resolveRelease;
    const { service } = await setup({ latestRelease: () => new Promise((resolve) => { resolveRelease = resolve; }) });
    const first = service.startDownload();
    await expect(service.startDownload()).rejects.toMatchObject({ reason: 'busy' });
    expect(service.cancel().cancelled).toBe(true);
    resolveRelease(release);
    await expect(first).rejects.toThrow();
    expect(service.status().state).toBe('cancelled');
  });
  it('cancels an active stream, removes partial files and permits retry', async () => {
    const fetchImpl = vi.fn().mockImplementationOnce(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([1])); },
    }))).mockImplementationOnce(async () => new Response(contents));
    const { service, directory } = await setup({ fetchImpl });
    await service.startDownload();
    await expect(service.startDownload()).rejects.toMatchObject({ reason: 'busy' });
    service.cancel(); await service.waitForDownload();
    expect(service.status()).toMatchObject({ state: 'cancelled', verified: false });
    expect(await readdir(directory)).toEqual([]);
    await service.startDownload(); await service.waitForDownload();
    expect(service.status()).toMatchObject({ state: 'downloaded', verified: true });
  });
  it('uses OS launch commands with the installer path passed as data', async () => {
    const execute = vi.fn();
    await openInstallerFile('/tmp/installer.dmg', 'darwin', execute);
    expect(execute).toHaveBeenLastCalledWith('open', ['/tmp/installer.dmg']);
    const file = "C:\\Users\\O'Neil\\installer.exe";
    await openInstallerFile(file, 'win32', execute);
    const [command, args, options] = execute.mock.lastCall;
    expect(command).toBe('powershell.exe');
    expect(args.join(' ')).not.toContain(file);
    expect(options.env.PILOTDECK_INSTALLER_PATH).toBe(file);
    expect(args.at(-1)).toContain('-ErrorAction Stop');
  });
});
