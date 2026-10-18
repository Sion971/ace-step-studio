// services/studio-busy.ts
//
// "Is something running that closing the page must not interrupt?" Used by the stop-on-close mechanism (presence.ts).

import { hasUnfinishedGeneration } from './acestep.js';
import { generationQueue } from './generationQueue.js';
import { pipelineManager } from './pipeline-manager.js';
import { trainingRunner } from './training-runner.js';
import { loraInstallRunning } from '../routes/lora-hub.js';

export function studioIsBusy(): boolean {
  if (hasUnfinishedGeneration() || generationQueue.pendingCount() > 0) return true;
  const training = trainingRunner.getStatus().state;
  if (training === 'starting' || training === 'running') return true;
  // A model file actually being fetched. (The phase alone says "downloading" as soon as a file is missing, even when nothing runs.)
  if (pipelineManager.getStatus().download.components.some((component) => component.state === 'downloading')) return true;
  return loraInstallRunning();
}
