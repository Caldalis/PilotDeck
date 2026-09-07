import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, realpath, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { compareVersions, getLatestRelease, listReleases, normalizeRepository } from './releaseService.js';

const exec = promisify(execFile);
const errorWithReason = (reason, message = reason, statusCode = 409) => Object.assign(new Error(message), { reason, statusCode });
const idle = () => ({ state: 'idle', progress: 0, receivedBytes: 0, totalBytes: null, filePath: null, asset: null, release: null, verified: false, error: null, reason: null });

export function selectDesktopAsset(release, { platform = process.platform, arch = process.arch } = {}) {
  if (!((platform === 'darwin' && ['arm64', 'x64'].includes(arch)) || (platform === 'win32' && arch === 'x64'))) return null;
  const extension = platform === 'darwin' ? '.dmg' : '-setup.exe';
  const matches = (release.assets || []).filter((asset) => asset.platform === platform && asset.arch === arch
    && asset.name.endsWith(extension) && /^[a-f0-9]{64}$/i.test(asset.sha256 || '') && Number.isSafeInteger(asset.size) && asset.size > 0);
  return matches.length === 1 ? matches[0] : null;
}

export function createDesktopUpdateService({
  env = process.env, platform = process.platform, arch = process.arch,
  fetchImpl = (...args) => fetch(...args),
  latestRelease = (options) => getLatestRelease({ ...options, fetchImpl, env }),
  openInstaller = (file) => openInstallerFile(file, platform),
} = {}) {
  let cachedStatus = null;
  let job = idle();
  let controller = null;
  let activeTask = null;
  let installing = false;
  const current = {
    version: env.PILOTDECK_DESKTOP_VERSION || env.PILOTDECK_VERSION || null,
    buildTime: env.PILOTDECK_DESKTOP_BUILD_TIME || null, commit: env.PILOTDECK_COMMIT_SHA || null,
    platform, arch, desktop: env.PILOTDECK_DESKTOP === '1' || Boolean(env.PILOTDECK_DESKTOP_VERSION),
  };
  const cacheRoot = path.resolve(env.PILOTDECK_UPDATE_CACHE_DIR || path.join(os.homedir(), '.pilotdeck', 'updates'));
  const snapshot = () => structuredClone(job);

  async function check({ force = false } = {}) {
    if (!force && cachedStatus && Date.now() - cachedStatus.time < 300_000) return { ...structuredClone(cachedStatus.value), cached: true };
    let repository;
    try {
      if (!current.desktop) throw errorWithReason('notDesktop');
      try { compareVersions(current.version, current.version); } catch { throw errorWithReason('invalidVersion'); }
      repository = normalizeRepository(env.PILOTDECK_UPDATE_REPOSITORY || env.PILOTDECK_RELEASE_REPOSITORY);
      const latest = await latestRelease({ repository });
      const hasUpdate = compareVersions(current.version, latest.version) < 0;
      const selectedAsset = selectDesktopAsset(latest, { platform, arch });
      const value = {
        scope: 'desktop', source: 'github-releases', repository, current,
        latest: { ...latest, selectedAsset }, hasUpdate, canDownload: hasUpdate && Boolean(selectedAsset),
        checkUnavailable: false, reason: hasUpdate && !selectedAsset ? 'noCompatibleInstaller' : null,
        status: hasUpdate ? 'update-available' : 'up-to-date', lastCheckedAt: new Date().toISOString(),
      };
      cachedStatus = { time: Date.now(), value };
      return structuredClone(value);
    } catch (error) {
      cachedStatus = null;
      return { scope: 'desktop', source: 'github-releases', repository, current, latest: null,
        hasUpdate: false, canDownload: false, checkUnavailable: true, reason: error.reason || 'checkFailed', message: error.message, status: 'unavailable' };
    }
  }

  async function startDownload() {
    if (activeTask || controller || installing) throw errorWithReason('busy');
    const abort = new AbortController();
    controller = abort;
    job = { ...idle(), state: 'downloading' };
    let directory;
    try {
      const status = await check({ force: true });
      if (!status.canDownload) throw errorWithReason(status.reason || (status.hasUpdate ? 'noCompatibleInstaller' : 'upToDate'));
      abort.signal.throwIfAborted();
      const asset = status.latest.selectedAsset;
      await mkdir(cacheRoot, { recursive: true });
      directory = await mkdtemp(path.join(cacheRoot, `${status.latest.tagName}-`));
      const filePath = path.join(directory, asset.name);
      job = { ...job, asset, release: { tagName: status.latest.tagName, version: status.latest.version }, totalBytes: asset.size, filePath };
      activeTask = download(asset, `${filePath}.download`, filePath, abort.signal)
        .then(() => { job = { ...job, state: 'downloaded', verified: true, progress: 1 }; })
        .catch(async (error) => {
          job = { ...job, state: abort.signal.aborted ? 'cancelled' : 'failed', verified: false,
            error: error.message, reason: abort.signal.aborted ? 'cancelled' : error.reason || 'downloadFailed' };
          await rm(directory, { recursive: true, force: true }).catch(() => {});
        })
        .finally(() => { activeTask = null; controller = null; });
      return snapshot();
    } catch (error) {
      job = { ...job, state: abort.signal.aborted ? 'cancelled' : 'failed', reason: abort.signal.aborted ? 'cancelled' : error.reason || 'downloadFailed', error: error.message };
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
      controller = null;
      throw error;
    }
  }

  async function download(asset, partial, destination, signal) {
    const hash = createHash('sha256');
    let received = 0;
    const timeout = AbortSignal.timeout(30 * 60 * 1000);
    const downloadSignal = AbortSignal.any([signal, timeout]);
    const response = await fetchImpl(asset.downloadUrl, { headers: { 'User-Agent': 'PilotDeck-Updater' }, signal: downloadSignal });
    if (!response.ok || !response.body) throw errorWithReason('downloadFailed', `Installer download failed (${response.status}).`);
    await pipeline(Readable.fromWeb(response.body), new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > asset.size) return callback(errorWithReason('checksumMismatch'));
        hash.update(chunk);
        job = { ...job, receivedBytes: received, progress: Math.min(received / asset.size, 0.99) };
        callback(null, chunk);
      },
    }), createWriteStream(partial, { flags: 'wx' }), { signal: downloadSignal });
    signal.throwIfAborted();
    if (received !== asset.size || hash.digest('hex') !== asset.sha256) throw errorWithReason('checksumMismatch');
    await rename(partial, destination);
  }

  function cancel() {
    const cancelled = Boolean(controller);
    controller?.abort();
    return { cancelled, download: snapshot() };
  }

  async function install({ filePath = job.filePath } = {}) {
    if (installing || controller || activeTask) throw errorWithReason('busy');
    if (job.state !== 'downloaded' || !job.verified || !filePath || filePath !== job.filePath) throw errorWithReason('notVerified');
    installing = true;
    try {
      const resolved = await realpath(filePath);
      const root = await realpath(cacheRoot);
      const relative = path.relative(root, resolved);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw errorWithReason('notVerified');
      const hash = createHash('sha256');
      let bytes = 0;
      for await (const chunk of createReadStream(resolved)) { hash.update(chunk); bytes += chunk.length; }
      if (bytes !== job.asset.size || hash.digest('hex') !== job.asset.sha256) throw errorWithReason('checksumMismatch');
      await openInstaller(resolved);
      job = { ...job, state: 'installerLaunched' };
      return { launched: true, filePath: resolved, needsRestart: true };
    } catch (error) {
      if (error.reason === 'checksumMismatch' || error.reason === 'notVerified' || error.code === 'ENOENT') {
        job = { ...job, state: 'failed', verified: false, reason: error.reason || 'notVerified', error: error.message };
      }
      throw error.reason ? error : errorWithReason('installFailed', error.message, 500);
    } finally { installing = false; }
  }
  return { check, startDownload, cancel, install, status: snapshot, waitForDownload: async () => { await activeTask; } };
}

export async function openInstallerFile(file, platform, execImpl = exec) {
  if (platform === 'darwin') { await execImpl('open', [file]); return; }
  if (platform !== 'win32') throw errorWithReason('noCompatibleInstaller');
  // ShellExecute allows the installer to request elevation. Pass the path as
  // data through the environment, never as interpolated PowerShell source.
  await execImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Start-Process -FilePath $env:PILOTDECK_INSTALLER_PATH -ErrorAction Stop'], {
    env: { ...process.env, PILOTDECK_INSTALLER_PATH: file }, windowsHide: true,
  });
}

const service = createDesktopUpdateService();
export const getDesktopUpdateStatus = (options) => service.check(options);
export const getDesktopDownloadStatus = () => service.status();
export const startDesktopUpdateDownload = () => service.startDownload();
export const cancelDesktopUpdateDownload = () => service.cancel();
export const launchDownloadedDesktopUpdate = (options) => service.install(options);
export async function listDesktopReleases({ limit = 10 } = {}) {
  const repository = normalizeRepository(process.env.PILOTDECK_UPDATE_REPOSITORY || process.env.PILOTDECK_RELEASE_REPOSITORY);
  const releases = await listReleases({ repository });
  return { repository, releases: releases.slice(0, Math.max(1, Math.min(30, Number(limit) || 10))).map((release) => ({
    tagName: release.tag_name, body: release.body || '', publishedAt: release.published_at,
    htmlUrl: `https://github.com/${repository}/releases/tag/${release.tag_name}`,
  })) };
}
