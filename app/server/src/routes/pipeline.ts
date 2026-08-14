import { Router } from 'express';
import { pipelineManager } from '../services/pipeline-manager.js';

const router = Router();

router.get('/status', (_req, res) => {
  res.json(pipelineManager.getStatus());
});

export default router;
