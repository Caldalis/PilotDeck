// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { getLatestRelease } from './releaseService.js';

const release = (tag, extras = {}) => ({ tag_name: tag, assets: [{ name: 'release.json' }], ...extras });
const manifest = { schemaVersion: 1, tag: 'v2026.09.07-r10', sourceSha: 'a'.repeat(40), repository: 'OpenBMB/PilotDeck' };
const response = (data) => ({ ok: true, json: async () => data });
describe('unified release discovery', () => {
  it('selects the latest stable dated release and validates its source manifest', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response([
      release('desktop-v2026.09.08'), release('v2026.09.07-r2'), release('v2026.09.07'),
      release('v2026.09.07-r10'), release('v2026.09.09', { prerelease: true }), release('v2026.09.10', { draft: true }),
    ])).mockResolvedValueOnce(response(manifest));
    expect(await getLatestRelease({ fetchImpl, env: {} })).toMatchObject({ tagName: manifest.tag, sourceSha: manifest.sourceSha });
    expect(fetchImpl.mock.calls[1][0]).toBe('https://github.com/OpenBMB/PilotDeck/releases/download/v2026.09.07-r10/release.json');
  });
  it.each([{ ...manifest, tag: 'wrong' }, { ...manifest, sourceSha: 'main' }, { ...manifest, repository: 'fork/PilotDeck' }])('rejects invalid source metadata', async (data) => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response([release(manifest.tag)])).mockResolvedValueOnce(response(data));
    await expect(getLatestRelease({ fetchImpl, env: {} })).rejects.toThrow('does not match');
  });
  it('fails closed without unified releases or a complete manifest', async () => {
    await expect(getLatestRelease({ fetchImpl: async () => response([release('desktop-v2026.09.07')]) })).rejects.toThrow('No unified');
    await expect(getLatestRelease({ fetchImpl: async () => response([release('v2026.09.07', { assets: [] })]) })).rejects.toThrow('no release.json');
  });
});
