import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { createWebUpdateRouter } from './webUpdate.js';
import {
  cancelDesktopUpdateDownload,
  getDesktopDownloadStatus,
  getDesktopUpdateStatus,
  launchDownloadedDesktopUpdate,
  listDesktopReleases,
  startDesktopUpdateDownload,
} from '../services/desktopUpdateService.js';
import {
  isSupervisorRestartEnabled,
  normalizeUpdateRuntimeError,
  requestSupervisorRestart,
  RESTART_EXIT_CODE,
  resolveRestartCommand,
} from '../services/updateRuntime.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

const router = express.Router();

// Keep the existing desktop scope adapter until desktop update migration.
router.post('/check', async (req, res, next) => {
  if (req.body?.scope !== 'desktop' && req.query.scope !== 'desktop') return next();
  const status = await getDesktopUpdateStatus({ force: req.body?.force === true || req.query.force === '1' });
  res.json(toLegacyCompatibleDesktopStatus(status));
});
router.use(createWebUpdateRouter());

/**
 * GET /api/update/desktop/status
 * Return desktop-app version status backed by GitHub Releases.
 */
router.get('/desktop/status', async (req, res) => {
  const force = req.query.force === '1' || req.query.force === 'true';
  const status = await getDesktopUpdateStatus({ force });
  res.json(status);
});

/**
 * POST /api/update/desktop/check
 * Force-check the latest desktop release.
 */
router.post('/desktop/check', async (_req, res) => {
  const status = await getDesktopUpdateStatus({ force: true });
  res.json(status);
});

/**
 * GET /api/update/desktop/releases
 * Return recent GitHub Release notes for the desktop About page.
 */
router.get('/desktop/releases', async (req, res) => {
  try {
    const limit = req.query.limit;
    const includePrerelease = req.query.includePrerelease === undefined
      ? undefined
      : req.query.includePrerelease === '1' || req.query.includePrerelease === 'true';
    const payload = await listDesktopReleases({ limit, includePrerelease });
    res.json(payload);
  } catch (error) {
    res.status(502).json({
      error: 'Failed to fetch desktop releases',
      message: error.message,
    });
  }
});

/**
 * POST /api/update/desktop/download
 * Start downloading the selected desktop installer asset.
 */
router.post('/desktop/download', async (req, res) => {
  try {
    const download = await startDesktopUpdateDownload({
      force: req.body?.force === true,
      assetId: req.body?.assetId,
      assetName: req.body?.assetName,
      platform: req.body?.platform,
      arch: req.body?.arch,
    });
    res.status(202).json({ success: true, download });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      error: 'Failed to start desktop update download',
      message: error.message,
    });
  }
});

/**
 * GET /api/update/desktop/download/status
 * Poll desktop installer download progress.
 */
router.get('/desktop/download/status', (_req, res) => {
  res.json({ download: getDesktopDownloadStatus() });
});

/**
 * POST /api/update/desktop/download/cancel
 * Cancel an in-flight desktop installer download.
 */
router.post('/desktop/download/cancel', (_req, res) => {
  res.json(cancelDesktopUpdateDownload());
});

/**
 * POST /api/update/desktop/install
 * Launch the downloaded installer through the OS shell.
 */
router.post('/desktop/install', (req, res) => {
  try {
    const result = launchDownloadedDesktopUpdate({ filePath: req.body?.filePath });
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      error: 'Failed to launch desktop update installer',
      message: error.message,
    });
  }
});

/**
 * POST /api/update/restart
 * Restart PilotDeck. In supervised source runtimes the outer supervisor
 * relaunches the full process group; direct server runs fall back to
 * self-respawn.
 */
export function createRestartHandler({
  env = process.env,
  spawnImpl = spawn,
  exit = process.exit,
  setTimeoutImpl = setTimeout,
  requestSupervisorRestartImpl = requestSupervisorRestart,
  resolveRestartCommandImpl = resolveRestartCommand,
  isSupervisorRestartEnabledImpl = isSupervisorRestartEnabled,
  projectRoot = PROJECT_ROOT,
  platform = process.platform,
  getInstanceInfo = (req) => req.app?.locals?.restartInstanceInfo,
  log = console.log,
  error = console.error,
} = {}) {
  const createAcceptedBody = (req, restartMode) => {
    const instanceInfo = getInstanceInfo(req) || {};
    return {
      status: 'accepted',
      restartMode,
      previousInstanceId: instanceInfo.instanceId ?? null,
      previousStartedAt: instanceInfo.startedAt ?? null,
      previousPid: instanceInfo.pid ?? null,
    };
  };

  return async (req, res) => {
    try {
      log('[update] Preparing replacement process and exit...');

      const isDocker = env.DOCKER === '1' || env.container === 'docker';

      if (isDocker) {
        res.status(202).json(createAcceptedBody(req, 'docker'));
        setTimeoutImpl(() => exit(0), 500);
        return;
      }

      if (isSupervisorRestartEnabledImpl(env)) {
        requestSupervisorRestartImpl({ env });
        res.status(202).json(createAcceptedBody(req, 'supervisor'));
        setTimeoutImpl(() => exit(RESTART_EXIT_CODE), 500);
        return;
      }

      // Local: spawn a replacement process detached from this one.
      const restartCommand = await resolveRestartCommandImpl({ projectRoot, env });
      const child = spawnImpl(restartCommand.command, restartCommand.args, {
        cwd: projectRoot,
        detached: true,
        stdio: 'ignore',
        env: { ...env },
        windowsHide: platform === 'win32',
      });

      await new Promise((resolve, reject) => {
        let settled = false;
        const settle = (callback, value) => {
          if (settled) return;
          settled = true;
          callback(value);
        };
        child.once('spawn', () => settle(resolve));
        child.once('error', (spawnError) => settle(reject, spawnError));
      });

      child.unref();

      res.status(202).json(createAcceptedBody(req, 'direct'));
      setTimeoutImpl(() => exit(0), 500);
    } catch (caughtError) {
      const message = normalizeUpdateRuntimeError(caughtError);
      error(`[update] Restart failed: ${message}`);
      res.status(500).json({
        error: 'Failed to restart PilotDeck',
        message,
      });
    }
  };
}

router.post('/restart', createRestartHandler());

function toLegacyCompatibleDesktopStatus(status) {
  const releaseSummary = status.latest
    ? [status.latest.tagName, status.latest.name].filter(Boolean).join(' ')
    : '';
  return {
    ...status,
    currentBranch: 'desktop',
    localHead: status.current?.version || 'unknown',
    remoteHead: status.latest?.version || '',
    behindCount: status.hasUpdate ? 1 : 0,
    newCommits: releaseSummary ? [releaseSummary] : [],
    currentCommit: status.current?.commit || '',
    hasUpdate: status.hasUpdate,
  };
}

export function createUpdateRouter(options = {}) {
  const restartRouter = express.Router();
  restartRouter.post('/restart', createRestartHandler(options));
  return restartRouter;
}

export default router;
