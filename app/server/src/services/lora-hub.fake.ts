// services/lora-hub.fake.ts
//
// A fake Hugging Face Hub for the tests of lora-hub.ts: two local HTTP servers, like the real thing. The "hub" answers the API
// (GET /api/models/<owner>/<name>?blobs=true, with `siblings`, `lfs.sha256` and the commit `sha`) and serves small files directly; weights are
// served by a second "cdn" server that the hub redirects to, so that redirects and the Authorization header across origins are exercised.
//
// Shape of the API as documented by the clients that use it (hf-fetch-model, modelshelf, sbom-tools): siblings[].{rfilename, size, lfs:{sha256,size}}.

import http from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';

export type WeightsBehavior = 'normal' | 'wrong-bytes' | 'oversize' | 'truncated' | 'stall' | 'gated';

export interface FakeRepo {
  sha?: string;
  gated?: boolean | string;
  requireToken?: boolean;
  cardData?: Record<string, unknown>;
  /** Free text written by the author: anything can be in there. */
  tags?: unknown[];
  files: Record<string, Buffer | string>;
  /** Publish no lfs block (no checksum) for the weights. */
  noLfs?: boolean;
  /** Replace the siblings list altogether (hostile names, odd shapes). */
  rawSiblings?: unknown[];
  /** Answer something that is not what the API returns. */
  rawBody?: string;
  weightsBehavior?: WeightsBehavior;
}

export interface FakeHub {
  endpoint: string;
  cdnOrigin: string;
  repos: Map<string, FakeRepo>;
  /** "<revision>:<file>" of every /resolve request. */
  resolved: string[];
  apiQueries: string[];
  hubHeaders: http.IncomingHttpHeaders[];
  cdnHeaders: http.IncomingHttpHeaders[];
  /** Force this status on API requests. */
  forceApiStatus?: number;
  /** When set, the cdn waits for it before sending the weights (to keep an install running). */
  gate?: Promise<void>;
  close(): Promise<void>;
}

export const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const bytes = (value: Buffer | string) => (typeof value === 'string' ? Buffer.from(value) : value);

/** A deterministic pseudo-random buffer, so that a corrupted copy really differs. */
export function fakeWeights(size: number, seed = 1): Buffer {
  const buffer = Buffer.alloc(size);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < size; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    buffer[i] = x >>> 24;
  }
  return buffer;
}

export const GOOD_ADAPTER_CONFIG = JSON.stringify({
  peft_type: 'LORA',
  r: 64,
  lora_alpha: 128,
  target_modules: ['q_proj', 'k_proj', 'v_proj', 'o_proj'],
  base_model_name_or_path: 'ACE-Step/Ace-Step1.5',
  task_type: null,
});

export async function startFakeHub(token = 'hf_test_token'): Promise<FakeHub> {
  const repos = new Map<string, FakeRepo>();
  const hub: FakeHub = { endpoint: '', cdnOrigin: '', repos, resolved: [], apiQueries: [], hubHeaders: [], cdnHeaders: [], close: async () => undefined };

  const siblingsOf = (repo: FakeRepo) =>
    repo.rawSiblings ??
    Object.entries(repo.files).map(([rfilename, content]) => {
      const data = bytes(content);
      const isWeights = rfilename.endsWith('.safetensors') || /\.(bin|pt|ckpt)$/.test(rfilename);
      return isWeights && !repo.noLfs
        ? { rfilename, size: data.length, blobId: sha256(rfilename).slice(0, 40), lfs: { sha256: sha256(data), size: data.length, pointerSize: 134 } }
        : { rfilename, size: data.length };
    });

  const authorized = (repo: FakeRepo, req: http.IncomingMessage) => !repo.requireToken || req.headers.authorization === `Bearer ${token}`;

  const cdn = http.createServer((req, res) => {
    hub.cdnHeaders.push(req.headers);
    const [, , repoId, file] = (req.url ?? '').split('/').map(decodeURIComponent);
    const repo = repos.get(repoId);
    const content = repo?.files[file];
    if (!repo || content === undefined) return void res.writeHead(404).end();
    const data = bytes(content);
    const behavior = repo.weightsBehavior ?? 'normal';
    const send = async () => {
      if (hub.gate) await hub.gate;
      if (behavior === 'wrong-bytes') {
        const wrong = Buffer.from(data);
        wrong[0] = wrong[0] ^ 0xff;
        res.writeHead(200, { 'Content-Length': wrong.length }).end(wrong);
      } else if (behavior === 'oversize') {
        res.writeHead(200).write(data);
        res.end(Buffer.alloc(4096, 7));
      } else if (behavior === 'truncated') {
        res.writeHead(200, { 'Content-Length': data.length });
        res.write(data.subarray(0, Math.floor(data.length / 2)));
        setTimeout(() => res.destroy(), 20);
      } else if (behavior === 'stall') {
        res.writeHead(200, { 'Content-Length': data.length });
        res.write(data.subarray(0, Math.floor(data.length / 2)));
        // never ends: the client must give up by itself
      } else {
        const half = Math.floor(data.length / 2);
        res.writeHead(200, { 'Content-Length': data.length });
        res.write(data.subarray(0, half));
        setTimeout(() => res.end(data.subarray(half)), 5);
      }
    };
    void send();
  });

  const server = http.createServer((req, res) => {
    hub.hubHeaders.push(req.headers);
    const url = new URL(req.url ?? '/', 'http://fake');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

    if (parts[0] === 'api' && parts[1] === 'models') {
      hub.apiQueries.push(url.search);
      if (hub.forceApiStatus) return void res.writeHead(hub.forceApiStatus, { 'Content-Type': 'application/json' }).end('{"error":"forced"}');
      const repo = repos.get(`${parts[2]}/${parts[3]}`);
      if (!repo) return void res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"Repository not found"}');
      if (!authorized(repo, req)) return void res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"error":"Invalid credentials"}');
      if (repo.rawBody !== undefined) return void res.writeHead(200).end(repo.rawBody);
      return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          id: `${parts[2]}/${parts[3]}`,
          sha: repo.sha ?? 'c0ffee0123456789abcdef0123456789abcdef01',
          private: false,
          gated: repo.gated ?? false,
          tags: repo.tags ?? ['peft', 'lora', 'ace-step'],
          cardData: repo.cardData ?? { license: 'cc-by-4.0', base_model: 'ACE-Step/Ace-Step1.5' },
          siblings: siblingsOf(repo),
        }),
      );
    }

    if (parts[2] === 'resolve') {
      const repo = repos.get(`${parts[0]}/${parts[1]}`);
      const file = parts.slice(4).join('/');
      hub.resolved.push(`${parts[3]}:${file}`);
      if (!repo || repo.files[file] === undefined) return void res.writeHead(404).end();
      if (!authorized(repo, req)) return void res.writeHead(401).end();
      if (/\.(safetensors|bin|pt|ckpt)$/.test(file)) {
        return void res.writeHead(302, { Location: `${hub.cdnOrigin}/blob/${encodeURIComponent(`${parts[0]}/${parts[1]}`)}/${encodeURIComponent(file)}` }).end();
      }
      const data = bytes(repo.files[file]);
      return void res.writeHead(200, { 'Content-Length': data.length }).end(data);
    }
    res.writeHead(404).end();
  });

  const listen = (s: http.Server) => new Promise<number>((resolve) => s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port)));
  const [hubPort, cdnPort] = await Promise.all([listen(server), listen(cdn)]);
  hub.endpoint = `http://127.0.0.1:${hubPort}`;
  hub.cdnOrigin = `http://127.0.0.1:${cdnPort}`;
  hub.close = async () => {
    for (const s of [server, cdn]) {
      s.closeAllConnections?.();
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  };
  return hub;
}
