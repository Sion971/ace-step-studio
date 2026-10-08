// routes/lora-hub-router.ts
//
// The HTTP face of the LoRA hub (services/lora-hub.ts, lora-catalog.ts, lora-compat.ts). Kept free of the Studio's own imports (database,
// Gradio) so that it can be tested with a stub for authentication; routes/lora-hub.ts wires it to the real authMiddleware, the real folders
// and the real catalog file.

import { Router, type Request, type RequestHandler, type Response } from 'express';
import { LoraHub, LoraHubError } from '../services/lora-hub.js';
import { checkCompatibility, requiredBase, type CardEvidence } from '../services/lora-compat.js';
import { catalogEntryFromCard, type ParsedCatalog } from '../services/lora-catalog.js';

export interface LoraHubRouterDeps {
  auth: RequestHandler;
  hub: LoraHub;
  /** The catalog, read at each request so that editing the file needs no restart. */
  catalog?: () => ParsedCatalog;
}

interface Context {
  activeModel?: string;
  vramGb?: number;
}

const invalid = (message: string) => ({ error: message });

/** The model that is loaded and the GPU memory, as the interface knows them. Both optional; anything that is not what it should be is refused. */
function readContext(source: Record<string, unknown>): Context | { error: string } {
  const context: Context = {};
  const model = source.activeModel;
  if (model !== undefined && model !== null) {
    if (typeof model !== 'string' || model.length > 100 || /[\u0000-\u001f]/.test(model)) return invalid('activeModel must be a short text');
    if (model.trim()) context.activeModel = model.trim();
  }
  const memory = source.vramGb;
  if (memory !== undefined && memory !== null && memory !== '') {
    const value = typeof memory === 'string' ? Number(memory) : memory;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1024) return invalid('vramGb must be a number of gigabytes between 0 and 1024');
    context.vramGb = value;
  }
  return context;
}

export function createLoraHubRouter(deps: LoraHubRouterDeps): Router {
  const router = Router();

  const fail = (res: Response, error: unknown) => {
    if (error instanceof LoraHubError) {
      res.status(error.status).json({ ...(error.details ?? {}), error: error.message, code: error.code });
      return;
    }
    console.error('[LoRA hub]', error);
    res.status(500).json({ error: 'Internal error.' });
  };

  // Which model is loaded comes from the client, which reads it from GET /api/generate/model-status once the engine has answered. The server's own
  // idea of it is NOT used as a fallback: generate.ts starts from its configured default and only replaces it after a successful poll, so before that
  // it is a default, not a loaded model, and a verdict built on it would be confident and wrong. Without a model, the verdict is "unknown".

  const compatibilityOf = (evidence: CardEvidence, context: Context) =>
    checkCompatibility({ required: requiredBase(evidence), activeModel: context.activeModel, vramGb: context.vramGb });

  /** Reads { source, file?, name? } and refuses anything that is not a string. */
  const readBody = (req: Request, res: Response): { source: string; file?: string; name?: string; body: Record<string, unknown> } | null => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.source !== 'string') {
      res.status(400).json({ error: 'source (string) is required', code: 'invalid_source' });
      return null;
    }
    for (const key of ['file', 'name'] as const) {
      if (body[key] !== undefined && typeof body[key] !== 'string') {
        res.status(400).json({ error: `${key} must be a string`, code: 'invalid_request' });
        return null;
      }
    }
    return { source: body.source, file: body.file as string | undefined, name: body.name as string | undefined, body };
  };

  // POST /api/lora-hub/inspect — what is in this repository, would it install, and does it suit the loaded model? Downloads only small JSON files.
  router.post('/inspect', deps.auth, async (req, res) => {
    const body = readBody(req, res);
    if (!body) return;
    const context = readContext(body.body);
    if ('error' in context) return void res.status(400).json({ ...context, code: 'invalid_request' });
    try {
      const card = await deps.hub.inspect(body.source, { file: body.file });
      res.json({ card, compatibility: compatibilityOf(card, context), catalogEntry: catalogEntryFromCard(card) });
    } catch (error) {
      fail(res, error);
    }
  });

  // POST /api/lora-hub/install — starts the install and answers at once with a job to poll.
  router.post('/install', deps.auth, async (req, res) => {
    const body = readBody(req, res);
    if (!body) return;
    try {
      res.status(202).json({ job: await deps.hub.startInstall(body.source, { file: body.file, name: body.name }) });
    } catch (error) {
      fail(res, error);
    }
  });

  // GET /api/lora-hub/installs/:id — progress of an install.
  router.get('/installs/:id', deps.auth, (req, res) => {
    const job = deps.hub.getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: 'Install not found (it may have expired).', code: 'not_found' });
      return;
    }
    res.json({ job });
  });

  // GET /api/lora-hub/installed — the LoRA this hub installed, with what was recorded then (trigger word, recommended settings).
  router.get('/installed', deps.auth, (_req, res) => {
    try {
      res.json({ installed: deps.hub.listInstalled() });
    } catch (error) {
      fail(res, error);
    }
  });

  // GET /api/lora-hub/catalog?activeModel=&vramGb= — the catalog, each entry with whether it is installed and whether it suits the loaded model.
  router.get('/catalog', deps.auth, async (req, res) => {
    const query = req.query as Record<string, unknown>;
    const context = readContext(query);
    if ('error' in context) return void res.status(400).json({ ...context, code: 'invalid_request' });
    try {
      const parsed = deps.catalog ? deps.catalog() : { entries: [], problems: [] };
      const installed = deps.hub.listInstalled();
      const entries = parsed.entries.map((entry) => ({
        ...entry,
        installed: installed.find((i) => i.repo === entry.repo && (entry.file === null || i.file === entry.file)) ?? null,
        compatibility: compatibilityOf({ baseModel: entry.baseModel ? [entry.baseModel] : [], tags: [], adapter: null, sidecar: null }, context),
      }));
      res.json({ entries, problems: parsed.problems });
    } catch (error) {
      fail(res, error);
    }
  });

  // POST /api/lora-hub/catalog/:id/install — installs an entry of the catalog, at the commit and with the checksum that entry pins.
  router.post('/catalog/:id/install', deps.auth, async (req, res) => {
    const entry = (deps.catalog ? deps.catalog().entries : []).find((e) => e.id === req.params.id);
    if (!entry) return void res.status(404).json({ error: 'This LoRA is not in the catalog.', code: 'not_found' });
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.name !== undefined && typeof body.name !== 'string') return void res.status(400).json({ error: 'name must be a string', code: 'invalid_request' });
    try {
      const job = await deps.hub.startInstall(entry.repo, {
        file: entry.file ?? undefined,
        revision: entry.revision ?? undefined,
        expectedSha256: entry.sha256 ?? undefined,
        name: (body.name as string | undefined) ?? entry.id,
      });
      res.status(202).json({ job });
    } catch (error) {
      fail(res, error);
    }
  });

  return router;
}
