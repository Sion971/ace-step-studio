// @vitest-environment node
//
// The real pipeline manager, without spawning anything: what the interface will read from /api/pipeline/status while the
// engine downloads, and what the console still shows.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const MARK = '[studio-download] ';
const marked = (payload: object) => `${MARK}${JSON.stringify(payload)}\n`;

describe('pipelineManager download status', () => {
  let root: string;
  let manager: any;
  let written: string[];
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'pm-dl-'));
    mkdirSync(path.join(root, 'ACE-Step-1.5', 'checkpoints'), { recursive: true });
    writeFileSync(
      path.join(root, 'hardware_profile.env'),
      'HW_GPU_NAME="NVIDIA GeForce GTX 1050"\nHW_MODE="gpu"\nHW_VRAM_TORCH_MIB="1996"\nHW_ACE_TIER="1"\nHW_DEFAULT_MODEL="acestep-v15-turbo"\nHW_INIT_LLM="false"\n',
    );
    Object.assign(process.env, {
      ACESTEP_PATH: path.join(root, 'ACE-Step-1.5'),
      DEFAULT_MODEL: 'acestep-v15-turbo',
      INIT_LLM: 'false',
      NO_AUTO_BROWSER: 'true',
    });
    delete process.env.ACESTEP_CHECKPOINTS_DIR;
    delete process.env.HARDWARE_PROFILE_PATH;
    vi.resetModules();
    ({ pipelineManager: manager } = await import('./pipeline-manager.js'));
    written = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      written.push(String(chunk));
      return true;
    });
    vi.spyOn(console, 'log').mockImplementation((...args: any[]) => {
      written.push(args.join(' ') + '\n');
    });
  });

  afterEach(async () => {
    await manager.shutdown();
    vi.restoreAllMocks();
    process.env = { ...savedEnv };
    rmSync(root, { recursive: true, force: true });
  });

  const status = () => manager.getStatus();
  const byId = () => Object.fromEntries(status().download.components.map((c: any) => [c.id, c]));

  it('announces a download as soon as the models are missing, with the hardware profile', () => {
    const { download } = status();
    expect(download.phase).toBe('downloading');
    expect(download.components.map((c: any) => [c.id, c.state])).toEqual([['main', 'pending'], ['acestep-v15-turbo', 'pending']]);
    expect(download.profile).toMatchObject({ gpuName: 'NVIDIA GeForce GTX 1050', tier: 1, vramGiB: 1.95, mode: 'gpu' });
  });

  it('follows the engine\'s events and keeps the marked lines out of the console', () => {
    manager.ingestStdout(marked({ event: 'start', component: 'main', repo: 'ACE-Step/Ace-Step1.5' }));
    manager.ingestStdout(marked({ event: 'bytes', component: 'main', done: 0, total: 1_540_000_000, files: 2 }));
    expect(byId().main).toMatchObject({ state: 'downloading', bytesDone: 0, bytesTotal: 1_540_000_000 });
    manager.ingestStdout(marked({ event: 'end', component: 'main', ok: true, seconds: 121 }));
    expect(byId().main).toMatchObject({ state: 'done', seconds: 121 });
    expect(written.join('')).not.toContain(MARK);
    expect(written.join('')).toContain('[Download] main: started');
    expect(written.join('')).toContain('[Download] main: done in 121s');
  });

  it('still echoes and parses ordinary engine output exactly as before', () => {
    manager.ingestStdout('GPU Memory: 1.95 GB\n');
    expect(written).toContain('[Gradio] GPU Memory: 1.95 GB\n');
    expect(status().message).toBe('GPU detected, configuring...');
  });

  it('separates a marked line from the text around it', () => {
    manager.ingestStdout(`one\n${marked({ event: 'start', component: 'main' })}two\n`);
    const echoed = written.filter((w) => w.startsWith('[Gradio]')).join('');
    expect(echoed).toBe('[Gradio] one\ntwo\n');
    expect(byId().main.state).toBe('downloading');
  });

  it('reassembles a marked line cut between two chunks', () => {
    const text = marked({ event: 'start', component: 'acestep-v15-turbo' });
    manager.ingestStdout(text.slice(0, 20));
    manager.ingestStdout(text.slice(20));
    expect(byId()['acestep-v15-turbo'].state).toBe('downloading');
    expect(written.join('')).not.toContain('studio-download');
  });

  it('turns a failed download into an error phase with its reason', () => {
    manager.ingestStdout(marked({ event: 'start', component: 'acestep-v15-turbo' }));
    manager.ingestStdout(marked({ event: 'end', component: 'acestep-v15-turbo', ok: false, error: 'No space left on device' }));
    expect(status().download.phase).toBe('error');
    expect(status().download.error).toBe('No space left on device');
    expect(written.join('')).toContain('FAILED — No space left on device');
  });

  it('reports ready once the engine says it is running', () => {
    manager.ingestStdout('Running on local URL:  http://0.0.0.0:8001\n');
    expect(status().state).toBe('ready');
    expect(status().download.phase).toBe('ready');
  });
});
