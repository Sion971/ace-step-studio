import { Router } from 'express';
import type { Presence } from '../services/presence.js';

const HEARTBEAT_MS = 15_000;

/**
 * GET / (mounted on /api/presence): a Server-Sent Events stream that does nothing but stay open. Its only meaning is "a Studio
 * page is open"; see services/presence.ts. The heartbeat keeps the connection alive through proxies and lets a dead connection
 * (a laptop that lost its network) fail its write and end.
 */
export function createPresenceRouter(presence: Presence, heartbeatMs: number = HEARTBEAT_MS): Router {
  const router = Router();
  router.get('/', (req, res) => {
    res.status(200).set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write('retry: 2000\n\n');

    const disconnect = presence.connect();
    const beat = setInterval(() => res.write(': ping\n\n'), heartbeatMs);
    const end = () => {
      clearInterval(beat);
      disconnect();
    };
    req.on('close', end);
    res.on('error', end);
  });
  return router;
}
