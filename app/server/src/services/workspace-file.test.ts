// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: Array<{ sql: string; params: unknown[] }> = [];
let owner: string | null = 'u1';
vi.mock('../db/pool.js', () => ({
  pool: {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('FROM playlists WHERE id')) return { rows: owner ? [{ user_id: owner }] : [] };
      if (sql.includes('MAX(pos)')) return { rows: [{ max_pos: 7 }] };
      return { rows: [] };
    }),
  },
}));
import { fileSongsInWorkspace } from './workspace-file.js';

beforeEach(() => { calls.length = 0; owner = 'u1'; });

describe('songs made inside a workspace', () => {
  it('go into that workspace, after its other songs', async () => {
    expect(await fileSongsInWorkspace('u1', 'w1', ['s1', 's2'])).toBe(true);
    const inserts = calls.filter((c) => c.sql.includes('INSERT INTO playlist_songs'));
    expect(inserts.map((c) => c.params)).toEqual([['w1', 's1', 8], ['w1', 's2', 9]]);
    // Only a workspace (not a playlist) is looked for.
    expect(calls[0].sql).toContain("kind = 'workspace'");
    // One value per placeholder (the SQLite pool turns each $n into "?").
    for (const c of calls) expect((c.sql.match(/\$\d+/g) || []).length).toBe(c.params.length);
  });

  it("never into someone else's workspace, a missing one, or with no workspace open", async () => {
    owner = 'other';
    expect(await fileSongsInWorkspace('u1', 'w1', ['s1'])).toBe(false);
    owner = null;
    expect(await fileSongsInWorkspace('u1', 'gone', ['s1'])).toBe(false);
    expect(await fileSongsInWorkspace('u1', undefined, ['s1'])).toBe(false);
    expect(await fileSongsInWorkspace('u1', 'w1', [])).toBe(false);
    expect(calls.some((c) => c.sql.includes('INSERT'))).toBe(false);
  });
});

describe('the path from the click to the workspace', () => {
  it('the interface sends the open workspace, the server keeps it with the job and files the songs', async () => {
    const { readFileSync } = await import('node:fs');
    const generate = readFileSync(new URL('../routes/generate.ts', import.meta.url), 'utf8');
    expect(generate).toMatch(/workspaceId: typeof workspaceId === 'string'/);
    expect(generate).toContain('fileSongsInWorkspace(req.user!.id, params.workspaceId, insertedSongIds)');
    const app = readFileSync(new URL('../../../App.tsx', import.meta.url), 'utf8');
    expect(app).toMatch(/_tempId: params\._tempId,\s+\/\/[^\n]*\n\s+workspaceId,/);
    // The card being made shows in the workspace it was asked from.
    expect(app).toContain('s.isGenerating ? s.workspaceId === activeWorkspaceFilter.id');
  });
});
