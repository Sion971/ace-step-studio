import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The status route is large and needs the whole pipeline; this pins the contract the interface relies on instead:
// both status responses carry `coverPending`, computed from the cover-jobs entry (consumed only once the song is updated).
describe('generate status: coverPending', () => {
  const src = readFileSync(resolve(__dirname, 'generate.ts'), 'utf8');

  it('is returned by the live status response and by the stored one', () => {
    expect(src.match(/coverPending: isCoverPending\(req\.params\.jobId\)/g)).toHaveLength(2);
  });

  it('counts a finished-but-not-yet-attached cover as pending', () => {
    expect(src).toMatch(/function isCoverPending\(jobId: string\): boolean \{\s*return getCoverState\(jobId\) !== undefined;/);
  });
});
