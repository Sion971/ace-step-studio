// @vitest-environment node
import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import express from 'express';
import http from 'http';
import os from 'os';
import path from 'path';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'fs';
import type { AddressInfo } from 'net';

const dir = mkdtempSync(path.join(os.tmpdir(), 'studio-projects-'));
process.env.STUDIO_PROJECTS_DIR = dir;

// The token check is not what is tested here: the user comes from a header.
vi.mock('../middleware/auth.js', () => ({
  authMiddleware: (req: any, res: any, next: any) => {
    const u = req.headers['x-test-user'];
    if (!u) { res.status(401).json({ error: 'No token provided' }); return; }
    req.user = { id: String(u), username: 'x' };
    next();
  },
}));

let server: http.Server;
let base = '';
beforeAll(async () => {
  const { default: router } = await import('./studio-projects.js');
  const app = express();
  app.use('/api/studio-projects', router);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/studio-projects`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

const as = (user: string) => ({ 'x-test-user': user });
function form(bytes: number[], fields: Record<string, string> = {}): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  f.append('project', new Blob([new Uint8Array(bytes)]), 'p.amss');
  return f;
}

describe('/api/studio-projects', () => {
  it('needs a signed-in user', async () => {
    expect((await fetch(base)).status).toBe(401);
    expect((await fetch(base, { method: 'POST', body: form([1]) })).status).toBe(401);
  });

  it('saves, lists, reads back, replaces and deletes a project', async () => {
    const created = await fetch(base, { method: 'POST', headers: as('u1'), body: form([1, 2, 3, 4], { name: 'Ma chanson' }) });
    expect(created.status).toBe(201);
    const { project } = await created.json();
    expect(project).toMatchObject({ name: 'Ma chanson', size: 4 });

    const list = await (await fetch(base, { headers: as('u1') })).json();
    expect(list.projects.map((p: any) => p.id)).toEqual([project.id]);

    const file = await fetch(`${base}/${project.id}/file`, { headers: as('u1') });
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));

    // replaced under the same id; no name given keeps the old one
    const again = await fetch(base, { method: 'POST', headers: as('u1'), body: form([9, 9, 9, 9, 9, 9], { id: project.id }) });
    expect(again.status).toBe(200);
    expect((await again.json()).project).toMatchObject({ id: project.id, name: 'Ma chanson', size: 6 });
    expect((await (await fetch(base, { headers: as('u1') })).json()).projects).toHaveLength(1);

    expect((await fetch(`${base}/${project.id}`, { method: 'DELETE', headers: as('u1') })).status).toBe(200);
    expect((await (await fetch(base, { headers: as('u1') })).json()).projects).toEqual([]);
    expect((await fetch(`${base}/${project.id}/file`, { headers: as('u1') })).status).toBe(404);
  });

  it('keeps each user to their own projects', async () => {
    const { project } = await (await fetch(base, { method: 'POST', headers: as('alice'), body: form([5]) })).json();
    expect((await (await fetch(base, { headers: as('bob') })).json()).projects).toEqual([]);
    expect((await fetch(`${base}/${project.id}/file`, { headers: as('bob') })).status).toBe(404);
    expect((await fetch(`${base}/${project.id}`, { method: 'DELETE', headers: as('bob') })).status).toBe(404);
    expect((await fetch(base, { method: 'POST', headers: as('bob'), body: form([1], { id: project.id }) })).status).toBe(404);
  });

  it('refuses ids that are not ids, and a request without a file', async () => {
    expect((await fetch(`${base}/..%2F..%2Fx/file`, { headers: as('u1') })).status).toBe(404);
    expect((await fetch(`${base}/not-an-id`, { method: 'DELETE', headers: as('u1') })).status).toBe(404);
    const f = new FormData(); f.append('name', 'x');
    expect((await fetch(base, { method: 'POST', headers: as('u1'), body: f })).status).toBe(400);
  });

  it('keeps one automatic backup per user, apart from the projects', async () => {
    expect((await (await fetch(`${base}/draft`, { headers: as('d1') })).json()).draft).toBeNull();
    expect((await fetch(`${base}/draft/file`, { headers: as('d1') })).status).toBe(404);
    const put = await fetch(`${base}/draft`, { method: 'PUT', headers: as('d1'), body: form([7, 7, 7]) });
    expect(put.status).toBe(200);
    expect((await put.json()).draft.size).toBe(3);
    // the next one replaces it
    await fetch(`${base}/draft`, { method: 'PUT', headers: as('d1'), body: form([1, 2, 3, 4, 5]) });
    const meta = (await (await fetch(`${base}/draft`, { headers: as('d1') })).json()).draft;
    expect(meta.size).toBe(5);
    expect(Number.isNaN(Date.parse(meta.updatedAt))).toBe(false);
    expect(new Uint8Array(await (await fetch(`${base}/draft/file`, { headers: as('d1') })).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    // not a project, and private to its user
    expect((await (await fetch(base, { headers: as('d1') })).json()).projects).toEqual([]);
    expect((await (await fetch(`${base}/draft`, { headers: as('d2') })).json()).draft).toBeNull();
    expect((await fetch(`${base}/draft`, { method: 'PUT', headers: { }, body: form([1]) })).status).toBe(401);
    expect((await fetch(`${base}/draft`, { method: 'DELETE', headers: as('d1') })).status).toBe(200);
    expect((await (await fetch(`${base}/draft`, { headers: as('d1') })).json()).draft).toBeNull();
    expect((await fetch(`${base}/draft`, { method: 'DELETE', headers: as('d1') })).status).toBe(200); // nothing left: still fine
  });

  it('refuses a backup without a file', async () => {
    const f = new FormData(); f.append('name', 'x');
    expect((await fetch(`${base}/draft`, { method: 'PUT', headers: as('d1'), body: f })).status).toBe(400);
  });

  it('leaves no temporary file behind', async () => {
    for (const sub of readdirSync(dir)) {
      expect(readdirSync(path.join(dir, sub)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    }
    expect(existsSync(dir)).toBe(true);
  });
});
