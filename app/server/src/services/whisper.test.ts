// @vitest-environment node
import { describe, expect, it } from 'vitest';
import path from 'path';
import { whisperSearchDirs } from './whisper.js';

describe('whisperSearchDirs', () => {
  const dirs = whisperSearchDirs({ WHISPER_PATH: '/custom', PATH: `/usr/bin${path.delimiter}/bin` } as NodeJS.ProcessEnv, '/studio');
  it('looks first where the user said, then in the Studio\'s own Python environment, then on the PATH', () => {
    expect(dirs[0]).toBe('/custom');
    expect(dirs).toContain(path.join('/studio', '.venv', process.platform === 'win32' ? 'Scripts' : 'bin'));
    expect(dirs.indexOf(path.join('/studio', '.venv', process.platform === 'win32' ? 'Scripts' : 'bin'))).toBeLessThan(dirs.indexOf('/usr/bin'));
    expect(dirs.slice(-2)).toEqual(['/usr/bin', '/bin']);
  });
  it('works without WHISPER_PATH', () => {
    expect(whisperSearchDirs({ PATH: '/x' } as NodeJS.ProcessEnv, '/studio')[0]).toContain('.venv');
  });
});
