// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import path from 'path';

// cover_worker.py patches huggingface_hub so that diffusers 0.40 imports with the huggingface_hub < 1.0 the installer keeps for
// transformers. Run only where a Python with huggingface_hub is at hand (the dev machine's venv python is not on the test PATH).
const scripts = path.resolve(__dirname, '../../scripts');
const hasHub = spawnSync('python3', ['-c', 'import huggingface_hub, tqdm'], { encoding: 'utf-8' }).status === 0;

describe.skipIf(!hasHub)('cover_worker.py hub compatibility', () => {
  it('gives huggingface_hub the two names diffusers 0.40 imports, and stays harmless when they exist', () => {
    const code = [
      'import cover_worker as w',
      'import huggingface_hub, huggingface_hub.errors as e',
      'w.patch_hub_for_diffusers(); w.patch_hub_for_diffusers()',
      'from huggingface_hub import get_cached_repo_tree',
      'from huggingface_hub.errors import CachedRepoTreeNotFoundError',
      'try:',
      '    get_cached_repo_tree("x")',
      'except CachedRepoTreeNotFoundError:',
      '    print("OK")',
    ].join('\n');
    const r = spawnSync('python3', ['-c', code], { encoding: 'utf-8', env: { ...process.env, PYTHONPATH: [scripts, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) } });
    expect(r.stdout.trim()).toBe('OK');
  });
});
