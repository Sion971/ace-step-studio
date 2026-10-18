// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { createPresenceRouter } from './presence.js';
import { Presence } from '../services/presence.js';

let server: http.Server | null = null;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server?.closeAllConnections();
  server = null;
});

async function start(presence: Presence, heartbeatMs = 15_000): Promise<number> {
  const app = express();
  app.use('/api/presence', createPresenceRouter(presence, heartbeatMs));
  server = http.createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
};

describe('GET /api/presence', () => {
  it('is an open event stream that counts as one page until the client leaves', async () => {
    const presence = new Presence({ onQuit: () => {}, enabled: false });
    const port = await start(presence, 20);
    let received = '';
    const req = http.get({ host: '127.0.0.1', port, path: '/api/presence' });
    const res = await new Promise<http.IncomingMessage>((resolve) => req.on('response', resolve));
    res.setEncoding('utf8');
    res.on('data', (chunk) => (received += chunk));

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    await until(() => presence.count === 1);
    await until(() => received.includes(': ping')); // the heartbeat keeps the stream alive
    expect(received.startsWith('retry:')).toBe(true);

    req.destroy(); // the tab is closed
    await until(() => presence.count === 0);
  });

  it('counts two pages separately', async () => {
    const presence = new Presence({ onQuit: () => {}, enabled: false });
    const port = await start(presence);
    const a = http.get({ host: '127.0.0.1', port, path: '/api/presence' });
    const b = http.get({ host: '127.0.0.1', port, path: '/api/presence' });
    await until(() => presence.count === 2);
    a.destroy();
    await until(() => presence.count === 1);
    b.destroy();
    await until(() => presence.count === 0);
  });
});
