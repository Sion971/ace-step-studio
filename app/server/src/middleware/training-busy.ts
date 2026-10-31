// middleware/training-busy.ts
//
// A LoRA training uses the card (about 1.8 GB in small-card mode, much more otherwise). If the engine is still alive and starts a
// generation at the same time, it takes most of the rest of the card for its own blocks and the training stops with "CUDA out of
// memory" (seen on an 8 GB card: the engine 5.1 GB + the training 1.8 GB). So while a training runs, the requests that would use the
// card are refused with a clear message, instead of killing a run that may have been going for hours.
import type { NextFunction, Request, Response } from 'express';
import { trainingRunner } from '../services/training-runner.js';

export const TRAINING_BUSY_MESSAGE =
  'A LoRA training is running: generation is paused until it ends (using the card at the same time would make the training fail).';

export function blockWhileTraining(_req: Request, res: Response, next: NextFunction): void {
  if (trainingRunner.isRunning()) {
    res.status(409).json({ error: TRAINING_BUSY_MESSAGE, code: 'training_running' });
    return;
  }
  next();
}
