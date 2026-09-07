// Shared release discovery. Installation policy belongs to each platform.
export const RELEASE_REPOSITORY = 'OpenBMB/PilotDeck';
export const RELEASE_TAG = /^v\d{4}\.\d{2}\.\d{2}(?:-r[1-9]\d*)?$/;
export const COMMIT_SHA = /^[a-f0-9]{40}$/;

export async function getLatestRelease({ fetchImpl = fetch, env = process.env } = {}) {
  const request = async (url) => {
    const response = await fetchImpl(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'PilotDeck-Updater',
        ...(env.PILOTDECK_GITHUB_TOKEN ? { Authorization: `Bearer ${env.PILOTDECK_GITHUB_TOKEN}` } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Release request failed (${response.status}).`);
    return response.json();
  };
  const releases = await request(`https://api.github.com/repos/${RELEASE_REPOSITORY}/releases?per_page=100`);
  if (!Array.isArray(releases)) throw new Error('Invalid release response.');
  const release = releases
    .filter((item) => !item.draft && !item.prerelease && RELEASE_TAG.test(item.tag_name || ''))
    .sort((a, b) => b.tag_name.localeCompare(a.tag_name, 'en', { numeric: true }))[0];
  if (!release) throw new Error('No unified PilotDeck release is available.');
  const manifestAsset = release.assets?.find((asset) => asset.name === 'release.json');
  if (!manifestAsset) throw new Error('The release has no release.json manifest.');
  // Use a known repository URL, never a URL supplied by the API payload.
  const manifest = await request(`https://github.com/${RELEASE_REPOSITORY}/releases/download/${release.tag_name}/release.json`);
  if (manifest.schemaVersion !== 1 || manifest.tag !== release.tag_name
      || manifest.repository !== RELEASE_REPOSITORY || !COMMIT_SHA.test(manifest.sourceSha || '')) {
    throw new Error('Release manifest does not match the published release.');
  }
  return {
    tagName: release.tag_name,
    sourceSha: manifest.sourceSha,
    publishedAt: release.published_at || null,
    body: release.body || '',
    htmlUrl: `https://github.com/${RELEASE_REPOSITORY}/releases/tag/${release.tag_name}`,
  };
}
