// @vitest-environment node
import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import router from './update.js';
import { launchDownloadedDesktopUpdate, startDesktopUpdateDownload } from '../services/desktopUpdateService.js';
vi.mock('../services/desktopUpdateService.js', () => ({
  cancelDesktopUpdateDownload: vi.fn(), getDesktopDownloadStatus: vi.fn(), getDesktopUpdateStatus: vi.fn(),
  launchDownloadedDesktopUpdate: vi.fn(), listDesktopReleases: vi.fn(), startDesktopUpdateDownload: vi.fn(),
}));
async function request(endpoint, body = {}) {
  const app = express(); app.use(express.json()); app.use('/api/update', router);
  const server = app.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/update/desktop/${endpoint}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  } finally { await new Promise((resolve) => server.close(resolve)); }
}
beforeEach(() => vi.resetAllMocks());
describe('desktop update routes', () => {
  it('ignores caller-supplied platform and asset overrides', async () => {
    startDesktopUpdateDownload.mockResolvedValue({ state: 'downloading' });
    expect(await request('download', { platform: 'win32', arch: 'arm64', assetName: 'unrelated.exe' })).toMatchObject({ status: 202 });
    expect(startDesktopUpdateDownload).toHaveBeenCalledWith();
  });
  it('awaits the actual installer launch result', async () => {
    launchDownloadedDesktopUpdate.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { launched: true };
    });
    expect(await request('install', { filePath: '/verified.dmg' })).toEqual({ status: 200, body: { success: true, launched: true } });
  });
  it('returns asynchronous launch errors instead of reporting success', async () => {
    launchDownloadedDesktopUpdate.mockRejectedValue(Object.assign(new Error('invalid hash'), { reason: 'checksumMismatch', statusCode: 409 }));
    expect(await request('install')).toMatchObject({ status: 409, body: { reason: 'checksumMismatch' } });
  });
});
