import express from 'express';
import { createWebUpdateService } from '../services/webUpdateService.js';

export function createWebUpdateRouter(service = createWebUpdateService()) {
  const router = express.Router();
  router.post('/check', async (_req, res) => res.json(await service.check()));
  router.get('/status', (_req, res) => res.json(service.status()));
  router.post('/apply', async (req, res) => {
    const send = (message) => {
      if (res.destroyed || res.writableEnded) return;
      if (!res.headersSent) {
        res.setHeader('Content-Type', 'application/x-ndjson');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('X-Accel-Buffering', 'no');
      }
      res.write(JSON.stringify({ ...message, timestamp: Date.now() }) + '\n');
    };
    try {
      await service.apply(req.body?.target, (message) => send({ stage: 'progress', status: 'running', message }), req.body?.updateId);
      send({ stage: 'complete', status: 'success', message: 'Update prepared. Restart to apply.' });
      res.end();
    } catch (error) {
      if (res.destroyed) return;
      if (!res.headersSent) {
        res.status(error.statusCode || 500).json({ reason: error.reason || 'applyFailed', message: error.message });
      } else {
        send({ stage: 'error', status: 'error', reason: error.reason || 'applyFailed', message: error.message });
        res.end();
      }
    }
  });
  return router;
}
