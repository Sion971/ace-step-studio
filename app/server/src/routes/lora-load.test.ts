// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// The engine and the authentication are replaced: what is under test is what the route does with the engine's ANSWER.
const predict = vi.fn();
vi.mock('../services/gradio-client.js', () => ({
  getGradioClient: async () => ({ predict }),
  callInitServiceWrapper: vi.fn(),
  fetchCurrentInitServiceValues: vi.fn(),
  QUANTIZATION_COMPONENT_ID: 1,
  MAIN_MODEL_PATH_COMPONENT_ID: 2,
}));
vi.mock('../middleware/auth.js', () => ({ authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next() }));

const { default: router } = await import('./lora.js');

describe('POST /api/lora/load: what the engine answered', () => {
  let server: Server;
  let base: string;

  beforeEach(async () => {
    predict.mockReset();
    const app = express();
    app.use(express.json());
    app.use('/api/lora', router);
    await new Promise<void>((resolve) => (server = app.listen(0, '127.0.0.1', () => resolve())));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/lora`;
    predict.mockResolvedValueOnce({ data: ['✅ LoRA unloaded'] });
    await fetch(`${base}/unload`, { method: 'POST' }); // start every test from "nothing loaded"
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  });

  const load = async (lora_path: unknown, engineAnswer?: unknown) => {
    if (engineAnswer !== undefined) predict.mockResolvedValueOnce({ data: [engineAnswer] });
    const response = await fetch(`${base}/load`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lora_path }) });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const state = async () => (await (await fetch(`${base}/status`)).json()) as { loaded: boolean; path: string };

  it('records a LoRA as loaded when the engine says it loaded it', async () => {
    const { status, body } = await load('./lora_output/final', '✅ LoRA loaded from ./lora_output/final');
    expect(status).toBe(200);
    expect(body).toMatchObject({ loaded: true, lora_path: './lora_output/final' });
    expect(await state()).toMatchObject({ loaded: true, path: './lora_output/final' });
    expect(predict).toHaveBeenLastCalledWith('/load_lora', ['./lora_output/final']);
  });

  it('does NOT record it as loaded when the engine refused, and says why', async () => {
    const { status, body } = await load('./lora_output/final', '❌ Failed to load LoRA: size mismatch for lora_A');
    expect(status).toBe(422);
    expect(body).toEqual({ error: 'Failed to load LoRA: size mismatch for lora_A', code: 'lora_load_failed' });
    expect(await state()).toMatchObject({ loaded: false, path: '' });
  });

  it('explains a folder name with a dot instead of passing on a message that says nothing', async () => {
    const { status, body } = await load('./lora_output/lo_fi-acestep1.5-v1', `❌ Failed to load LoRA: 'module name can\\'t contain ".", got: lo_fi-acestep1.5-v1'`);
    expect(status).toBe(422);
    expect(body.code).toBe('invalid_adapter_name');
    expect(body.error).toContain('Rename the folder to "lo_fi-acestep1_5-v1"');
    expect((await state()).loaded).toBe(false);
  });

  it('keeps a LoRA that was already loaded when a second one is refused', async () => {
    await load('./lora_output/first', '✅ loaded');
    await load('./lora_output/second', '❌ Failed to load LoRA: boom');
    expect(await state()).toMatchObject({ loaded: true, path: './lora_output/first' });
  });

  it('is unchanged for the cases that were already handled', async () => {
    expect((await load(undefined)).status).toBe(400);
    expect((await load(42)).status).toBe(400);
    predict.mockRejectedValueOnce(new Error('engine is not running'));
    const down = await load('./lora_output/final');
    expect(down.status).toBe(500);
    expect(down.body.error).toBe('engine is not running');
    expect((await load('./lora_output/final', undefined as never)).status).toBeGreaterThanOrEqual(200);
  });

  it('takes an answer it does not understand for a success, as before: no failure is invented', async () => {
    const { status, body } = await load('./lora_output/final', 'ok');
    expect(status).toBe(200);
    expect(body.loaded).toBe(true);
  });
});
