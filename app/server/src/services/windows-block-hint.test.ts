// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { windowsBlockHint } from './windows-block-hint.js';

describe('help printed when Windows refuses to start the engine', () => {
  const folder = 'C:\\Users\\me\\ace-step-studio';

  it('explains spawn UNKNOWN on Windows and names the exclusion command', () => {
    const hint = windowsBlockHint(new Error('spawn UNKNOWN'), folder, 'win32');
    expect(hint).toContain('Smart App Control');
    expect(hint).toContain('Add-MpPreference -ExclusionPath');
    expect(hint).toContain('ace-step-studio');
  });

  it('also reads the error code', () => {
    expect(windowsBlockHint({ code: 'UNKNOWN', message: 'spawn failed' }, folder, 'win32')).not.toBeNull();
  });

  it('stays silent for other errors and on other systems', () => {
    expect(windowsBlockHint(new Error('Python not found: x'), folder, 'win32')).toBeNull();
    expect(windowsBlockHint(new Error('spawn UNKNOWN'), folder, 'linux')).toBeNull();
    expect(windowsBlockHint(null, folder, 'win32')).toBeNull();
  });
});
