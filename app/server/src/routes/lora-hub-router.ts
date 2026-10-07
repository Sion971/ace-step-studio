// routes/lora-hub-router.ts
//
// The HTTP face of services/lora-hub.ts. Kept free of the Studio's own imports (database, Gradio) so that it can be tested with a stub for
// authentication; routes/lora-hub.ts wires it to the real authMiddleware and the real folders.

import { Router, type Request, type RequestHandler, type Response } from 'express';
import { LoraHub, LoraHubError } from '../services/lora-hub.js';

export function createLoraHubRouter(deps: { auth: RequestHandler; hub: LoraHub }): Router {
  const router = Router();

  const fail = (res: Response, error: unknown) => {
    if (error instanceof LoraHubError) {
      res.status(error.status).json({ ...(error.details ?? {}), error: error.message, code: error.code });
      return;
    }
    console.error('[LoRA hub]', error);
    res.status(500).json({ error: 'Internal error.' });
  };

  /** Reads { source, file?, name? } and refuses anything that is not a string. */
  const readBody = (req: Request, res: Response): { source: string; file?: string; name?: string } | null => {
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
    return { source: body.source, file: body.file as string | undefined, name: body.name as string | undefined };
  };

  // POST /api/lora-hub/inspect — what is in this repository, and would it install? Downloads nothing but two small JSON files.
  router.post('/inspect', deps.auth, async (req, res) => {
    const body = readBody(req, res);
    if (!body) return;
    try {
      res.json({ card: await deps.hub.inspect(body.source, { file: body.file }) });
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

  return router;
}
