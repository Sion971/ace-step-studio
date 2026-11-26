// @vitest-environment node
import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { SavedStyle, SavedStylesStore } from './saved-styles.js';

// The token check is not what is tested here: the user comes from a header.
vi.mock('../middleware/auth.js', () => ({
  authMiddleware: (req: any, res: any, next: any) => {
    const u = req.headers['x-test-user'];
    if (!u) { res.status(401).json({ error: 'No token provided' }); return; }
    req.user = { id: String(u), username: 'x' };
    next();
  },
}));

// A store in memory, ordered like the database's (last saved or saved again first).
let clock = 0;
const rows: (SavedStyle & { user_id: string })[] = [];
const store: SavedStylesStore = {
  async list(u) { return rows.filter(r => r.user_id === u).sort((a, b) => b.updated_at.localeCompare(a.updated_at)); },
  async findByStyle(u, style) { return rows.find(r => r.user_id === u && r.style === style) ?? null; },
  async insert(u, row) { const t = String(++clock).padStart(6, '0'); const r = { ...row, user_id: u, created_at: t, updated_at: t }; rows.push(r); return r; },
  async touch(u, id, name) { const r = rows.find(x => x.id === id && x.user_id === u); if (!r) return null; r.updated_at = String(++clock).padStart(6, '0'); if (name) r.name = name; return r; },
  async rename(u, id, name) { const r = rows.find(x => x.id === id && x.user_id === u); if (!r) return null; r.name = name; return r; },
  async remove(u, id) { const i = rows.findIndex(x => x.id === id && x.user_id === u); if (i < 0) return false; rows.splice(i, 1); return true; },
};

let server: http.Server;
let base = '';
beforeAll(async () => {
  const { createSavedStylesRouter } = await import('./saved-styles.js');
  const app = express();
  app.use(express.json());
  app.use('/api/saved-styles', createSavedStylesRouter(store));
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/saved-styles`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

const as = (user: string) => ({ 'x-test-user': user, 'Content-Type': 'application/json' });
const save = (user: string, body: object) => fetch(base, { method: 'POST', headers: as(user), body: JSON.stringify(body) });

describe('/api/saved-styles', () => {
  it('needs a signed-in user', async () => {
    expect((await fetch(base)).status).toBe(401);
  });

  it('saves a style named after its start, lists it, renames and deletes it', async () => {
    const r = await save('u1', { style: '  synthétiseur éthéré, synthétiseur électronique, pads lumineux, voix douce  ' });
    expect(r.status).toBe(201);
    const { style } = await r.json();
    expect(style.style).toBe('synthétiseur éthéré, synthétiseur électronique, pads lumineux, voix douce');
    // Named after the start of the style: its first 40 characters and an ellipsis.
    expect(style.name).toBe(`${style.style.slice(0, 40).trimEnd()}…`);
    expect(style.name.startsWith('synthétiseur éthéré, synthétiseur')).toBe(true);

    const list = await (await fetch(base, { headers: as('u1') })).json();
    expect(list.styles.map((s: any) => s.id)).toEqual([style.id]);
    expect((await (await fetch(base, { headers: as('u2') })).json()).styles).toEqual([]);

    const renamed = await fetch(`${base}/${style.id}`, { method: 'PATCH', headers: as('u1'), body: JSON.stringify({ name: 'Nuit synthé' }) });
    expect((await renamed.json()).style.name).toBe('Nuit synthé');
    // Another user can neither rename nor delete it.
    expect((await fetch(`${base}/${style.id}`, { method: 'DELETE', headers: as('u2') })).status).toBe(404);
    expect((await fetch(`${base}/${style.id}`, { method: 'DELETE', headers: as('u1') })).status).toBe(200);
    expect((await (await fetch(base, { headers: as('u1') })).json()).styles).toEqual([]);
  });

  it('keeps the same text once: saving it again moves it back to the top', async () => {
    const a = (await (await save('u3', { style: 'zouk, kompa' })).json()).style;
    const b = (await (await save('u3', { style: 'gwoka, ka drums' })).json()).style;
    const again = await save('u3', { style: 'zouk, kompa' });
    expect(again.status).toBe(200);
    expect((await again.json()).existed).toBe(true);
    const ids = (await (await fetch(base, { headers: as('u3') })).json()).styles.map((s: any) => s.id);
    expect(ids).toEqual([a.id, b.id]);
  });

  it('refuses an empty style or name', async () => {
    expect((await save('u1', { style: '   ' })).status).toBe(400);
    const s = (await (await save('u1', { style: 'jazz' })).json()).style;
    expect((await fetch(`${base}/${s.id}`, { method: 'PATCH', headers: as('u1'), body: JSON.stringify({ name: ' ' }) })).status).toBe(400);
  });
});
