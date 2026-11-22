/**
 * app/server/src/services/training-runner.ts
 *
 * Gère le processus d'entraînement LoRA (Side-Step CLI : `train.py fixed`).
 *
 * Pourquoi un service et pas un simple spawn dans la route :
 *   - un entraînement dure plusieurs minutes → aucune requête HTTP ne peut
 *     rester ouverte jusqu'au bout
 *   - le front a besoin de la progression en direct → polling sur /status
 *   - il faut pouvoir arrêter proprement (SIGTERM) et savoir si ça tourne
 *
 * Calqué sur pipeline-manager.ts (même style : classe singleton, machine à
 * états, ChildProcess conservé).
 */

import { spawn, ChildProcess } from 'child_process';
import { existsSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

/* ---------------------------------------------------------------------------
 * Types
 * -------------------------------------------------------------------------*/

/** paused: stopped on request after an epoch, with a checkpoint to resume from (lastCheckpoint). */
export type TrainingState = 'idle' | 'starting' | 'running' | 'paused' | 'completed' | 'error' | 'stopped';

export interface TrainingMetricPoint {
  epoch: number;
  loss: number;
}

export interface TrainingParams {
  // Données / modèle
  checkpointDir?: string;
  modelVariant?: string;        // base | sft | turbo | xl_* | nom de dossier
  tensorDir?: string;
  outputDir?: string;

  // Adaptateur
  adapterType?: 'lora' | 'lokr';
  rank?: number;
  alpha?: number;
  dropout?: number;
  /** Couches d'attention visées : both | self | cross (train.py --attention-type). */
  attentionType?: string;

  // Entraînement
  learningRate?: number;
  batchSize?: number;
  gradientAccumulation?: number;
  epochs?: number;
  seed?: number;
  shift?: number;
  saveEvery?: number;
  resumeCheckpoint?: string | null;
  warmupSteps?: number;
  /** cosine | cosine_restarts | linear | constant | constant_with_warmup (train.py --scheduler-type). */
  schedulerType?: string;
  /** Probabilite de remplacer la condition par la condition nulle (CFG dropout), entre 0 et 1. */
  cfgRatio?: number;

  // Mémoire / performance
  precision?: 'auto' | 'bf16' | 'fp16' | 'fp32';
  optimizerType?: 'adamw' | 'adamw8bit' | 'adafactor' | 'prodigy';
  gradientCheckpointing?: boolean;
  offloadEncoder?: boolean;
  /** Small-card mode: the frozen weights stay in RAM and pass through the card block by block (LoRA and LoKr). */
  streamBlocks?: boolean;
  numWorkers?: number;
  /** Fréquence des lignes de log (1 = une par époque). Requis pour la progression. */
  logEvery?: number;

  /** Arrête le serveur Gradio pendant l'entraînement pour libérer la VRAM. */
  freeVram?: boolean;
}

export interface TrainingStatus {
  state: TrainingState;
  message: string;
  pid: number | null;
  epoch: number;
  totalEpochs: number;
  loss: number | null;
  bestLoss: number | null;
  lastEpochSec: number | null;
  etaSec: number | null;
  lastCheckpoint: string | null;
  trainableParams: number | null;
  elapsedSec: number | null;
  metrics: TrainingMetricPoint[];
  log: string;
  lastError: string | null;
  outputPath: string | null;
  /** A pause was asked: the run stops after the current epoch, with a checkpoint. */
  pauseRequested: boolean;
}

/* ---------------------------------------------------------------------------
 * Analyse de la sortie de Side-Step
 * -------------------------------------------------------------------------*/

/*
 * Format réel de la sortie Side-Step en mode --plain (vérifié sur v2.0.0).
 * ATTENTION : en --plain, l'affichage Rich est désactivé — il n'y a NI barre de
 * progression, NI ligne VRAM. Seules les lignes ci-dessous sont émises, et
 * uniquement si --log-every est fourni (mettre 1 pour une ligne par époque).
 *
 * Side-Step émet DEUX lignes par époque avec les mêmes valeurs :
 *     Epoch 1/20, Step 1, Loss: 0.9480
 *     [OK] Epoch 1/20 in 2.9s, Loss: 0.9480
 * On ne parse que la seconde (préfixe [OK]) : elle porte aussi la durée, et
 * cela évite de compter chaque époque deux fois.
 */

/** `[OK] Epoch 1/20 in 2.9s, Loss: 0.9480` */
const RE_EPOCH = /\[OK\]\s*Epoch\s+(\d+)\s*\/\s*(\d+)\s+in\s+([\d.]+)s,\s*Loss:\s*([\d.]+)/i;

/** `[OK] LoRA adapter saved to lora_output/checkpoints/epoch_10_loss_0.5288` (LoRA only; `/` or `\` on Windows) */
const RE_CHECKPOINT = /LoRA adapter saved to\s+(\S*checkpoints[\\/]\S+)/i;

/** `[OK] Checkpoint saved at epoch 10: lora_output/checkpoints/epoch_10_loss_0.5288` (LoRA and LoKr) */
const RE_CHECKPOINT_AT = /\[OK\]\s*Checkpoint saved at epoch\s+\d+:\s*(.+?)\s*$/i;

/** `[PAUSED] Training paused after epoch 4/20. Resume from: lora_output/checkpoints/epoch_4_loss_0.5000` */
const RE_PAUSED = /\[PAUSED\][^\n]*Resume from:\s*(.+?)\s*$/i;

/** `[OK] Training complete! LoRA saved to lora_output/final` */
const RE_FINAL = /Training complete!\s*LoRA saved to\s+(\S+)/i;

/** `[OK] Adapter verified: 22,020,096 params, ...` */
const RE_VERIFIED = /Adapter verified:\s*([\d,]+)\s*params/i;

/** Erreurs fatales */
const RE_FAILED = /(?:Training failed|CUDA out of memory|OutOfMemoryError|Traceback \(most recent call last\))/i;

/* ---------------------------------------------------------------------------
 * Service
 * -------------------------------------------------------------------------*/

const MAX_LOG_CHARS = 60_000;   // le front n'affiche que la fin
const MAX_METRIC_POINTS = 2_000;

class TrainingRunner {
  private process: ChildProcess | null = null;
  private state: TrainingState = 'idle';
  private message = '';
  private lastError: string | null = null;
  private startedAt: number | null = null;

  private epoch = 0;
  private totalEpochs = 0;
  private loss: number | null = null;
  private bestLoss: number | null = null;
  private lastEpochSec: number | null = null;
  private lastCheckpoint: string | null = null;
  private trainableParams: number | null = null;
  private outputPath: string | null = null;

  private metrics: TrainingMetricPoint[] = [];
  private log = '';
  private stdoutTail = '';
  private finishListeners: Array<() => void> = [];
  /** File whose creation asks train.py to pause after the current epoch (ACESTEP_TRAINING_PAUSE_FILE). */
  private pauseFile: string | null = null;
  private pauseRequested = false;
  private pausedAt: string | null = null;

  /* -- État --------------------------------------------------------------- */

  isRunning(): boolean {
    return this.state === 'starting' || this.state === 'running';
  }

  /** Calls `cb` once, when the current run ends (completed, stopped or failed). */
  onFinish(cb: () => void): void {
    this.finishListeners.push(cb);
  }

  private notifyFinished(): void {
    const listeners = this.finishListeners;
    this.finishListeners = [];
    for (const cb of listeners) {
      try {
        cb();
      } catch (err) {
        console.error('[Training] onFinish listener failed:', err);
      }
    }
  }

  getStatus(): TrainingStatus {
    return {
      state: this.state,
      message: this.message,
      pid: this.process?.pid ?? null,
      epoch: this.epoch,
      totalEpochs: this.totalEpochs,
      loss: this.loss,
      bestLoss: this.bestLoss,
      lastEpochSec: this.lastEpochSec,
      etaSec: this.computeEta(),
      lastCheckpoint: this.lastCheckpoint,
      trainableParams: this.trainableParams,
      elapsedSec: this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : null,
      metrics: this.metrics,
      log: this.log,
      lastError: this.lastError,
      outputPath: this.outputPath,
      pauseRequested: this.pauseRequested && this.isRunning(),
    };
  }

  private reset(totalEpochs: number): void {
    this.epoch = 0;
    this.totalEpochs = totalEpochs;
    this.loss = null;
    this.bestLoss = null;
    this.lastEpochSec = null;
    this.lastCheckpoint = null;
    this.trainableParams = null;
    this.outputPath = null;
    this.metrics = [];
    this.log = '';
    this.stdoutTail = '';
    this.lastError = null;
    this.pauseRequested = false;
    this.pausedAt = null;
    this.startedAt = Date.now();
  }

  /* -- Construction des arguments CLI ------------------------------------- */

  /**
   * Traduit les paramètres de l'UI en arguments `train.py fixed`.
   * Les valeurs par défaut correspondent à ce qui fonctionne sur une carte 8 Go.
   */
  buildArgs(p: TrainingParams): string[] {
    // --yes et --plain sont des options GLOBALES : elles doivent précéder
    // le sous-commande `fixed`, sinon argparse les rejette.
    const args: string[] = [
      '--yes',                        // pas de confirmation interactive
      '--plain',                      // pas de Rich : sortie parsable ligne à ligne
      'fixed',
      '--checkpoint-dir', p.checkpointDir ?? './checkpoints',
      '--dataset-dir', p.tensorDir ?? './datasets/preprocessed_tensors',
      '--output-dir', p.outputDir ?? './lora_output',
    ];

    if (p.modelVariant) args.push('--model-variant', p.modelVariant);

    // Adaptateur
    args.push('--adapter-type', p.adapterType ?? 'lora');
    if (p.adapterType === 'lokr') {
      // LoKr has its own size settings: --rank / --alpha only exist for LoRA and were ignored (LoKr then trained with 64 / 128).
      if (p.rank != null) args.push('--lokr-linear-dim', String(p.rank));
      if (p.alpha != null) args.push('--lokr-linear-alpha', String(p.alpha));
    } else {
      if (p.rank != null) args.push('--rank', String(p.rank));
      if (p.alpha != null) args.push('--alpha', String(p.alpha));
    }
    if (p.dropout != null) args.push('--dropout', String(p.dropout));

    // Entraînement
    if (p.learningRate != null) args.push('--lr', String(p.learningRate));
    if (p.batchSize != null) args.push('--batch-size', String(p.batchSize));
    if (p.gradientAccumulation != null) {
      args.push('--gradient-accumulation', String(p.gradientAccumulation));
    }
    if (p.epochs != null) args.push('--epochs', String(p.epochs));
    if (p.seed != null) args.push('--seed', String(p.seed));
    if (p.shift != null) args.push('--shift', String(p.shift));
    if (p.saveEvery != null) args.push('--save-every', String(p.saveEvery));
    if (p.resumeCheckpoint) args.push('--resume-from', p.resumeCheckpoint);
    // Valeurs verifiees ici : train.py les refuserait avec un message d'argparse peu lisible pour l'utilisateur.
    const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
    if (finite(p.warmupSteps) && p.warmupSteps >= 0) args.push('--warmup-steps', String(Math.round(p.warmupSteps)));
    if (p.schedulerType && ['cosine', 'cosine_restarts', 'linear', 'constant', 'constant_with_warmup'].includes(p.schedulerType)) {
      args.push('--scheduler-type', p.schedulerType);
    }
    if (finite(p.cfgRatio) && p.cfgRatio >= 0 && p.cfgRatio <= 1) args.push('--cfg-ratio', String(p.cfgRatio));
    if (p.attentionType && ['both', 'self', 'cross'].includes(p.attentionType)) args.push('--attention-type', p.attentionType);

    // Mémoire
    args.push('--precision', p.precision ?? 'bf16');
    args.push('--optimizer-type', p.optimizerType ?? 'adamw8bit');
    args.push(p.gradientCheckpointing === false
      ? '--no-gradient-checkpointing'
      : '--gradient-checkpointing');
    if (p.offloadEncoder !== false) args.push('--offload-encoder');
    if (p.streamBlocks === true) args.push('--stream-blocks', '--stream-prefetch');
    args.push('--num-workers', String(p.numWorkers ?? 0));

    // Indispensable : sans --log-every, le mode --plain n'émet AUCUNE ligne de
    // progression et le front resterait figé à 0 %.
    args.push('--log-every', String(p.logEvery ?? 1));

    return args;
  }

  /* -- Démarrage ----------------------------------------------------------- */

  start(params: TrainingParams, pythonPath: string, aceStepDir: string): void {
    if (this.isRunning()) {
      throw new Error('A training run is already in progress');
    }

    const trainScript = path.join(aceStepDir, 'train.py');
    if (!existsSync(trainScript)) {
      throw new Error(`train.py not found: ${trainScript}`);
    }

    const args = [trainScript, ...this.buildArgs(params)];

    this.reset(params.epochs ?? 0);
    this.state = 'starting';
    this.message = "Démarrage de l'entraînement...";
    this.appendLog(`$ ${pythonPath} ${args.join(' ')}\n`);

    this.clearPauseFile();
    this.pauseFile = path.join(tmpdir(), `acestep-training-pause-${process.pid}-${Date.now()}`);
    this.process = spawn(pythonPath, args, {
      cwd: aceStepDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1', ACESTEP_TRAINING_PAUSE_FILE: this.pauseFile },
    });

    console.log(`[Training] spawn pid=${this.process.pid ?? 'AUCUN'}`);

    this.process.stdout?.on('data', (d: Buffer) => this.consume(d.toString()));
    this.process.stderr?.on('data', (d: Buffer) => this.consume(d.toString()));

    this.process.on('error', (err: Error) => {
      console.error('[Training] spawn error:', err);
      this.state = 'error';
      this.lastError = err.message;
      this.message = `Lancement impossible : ${err.message}`;
      this.process = null;
      this.clearPauseFile();
      this.notifyFinished();
    });

    this.process.on('close', (code: number | null, signal: string | null) => {
      this.process = null;
      this.clearPauseFile();
      if (signal === 'SIGTERM' || this.state === 'stopped') {
        this.state = 'stopped';
        this.message = 'Entraînement arrêté';
      } else if (code === 0 && this.pausedAt) {
        this.state = 'paused';
        this.lastCheckpoint = this.pausedAt;
        this.message = `En pause après l'époque ${this.epoch}/${this.totalEpochs} — reprise possible depuis le checkpoint`;
      } else if (code === 0) {
        this.state = 'completed';
        this.message = this.outputPath
          ? `Entraînement terminé — adaptateur : ${this.outputPath}`
          : 'Entraînement terminé';
      } else {
        this.state = 'error';
        this.message = `Entraînement échoué (code ${code})`;
        if (!this.lastError) this.lastError = this.tailLog(1200);
      }
      this.notifyFinished();
    });
  }

  /* -- Consommation de la sortie ------------------------------------------ */

  private consume(chunk: string): void {
    this.appendLog(chunk);

    this.stdoutTail += chunk;
    const lines = this.stdoutTail.split('\n');
    this.stdoutTail = lines.pop() ?? '';   // fragment incomplet conservé

    for (const line of lines) this.parseLine(line);
  }

  private parseLine(line: string): void {
    if (this.state === 'starting') {
      this.state = 'running';
      this.message = 'Entraînement en cours';
    }

    const mEpoch = RE_EPOCH.exec(line);
    if (mEpoch) {
      const epoch = Number(mEpoch[1]);
      const total = Number(mEpoch[2]);
      const secs = Number(mEpoch[3]);
      const loss = Number(mEpoch[4]);
      if (Number.isFinite(epoch)) this.epoch = epoch;
      if (Number.isFinite(total) && total > 0) this.totalEpochs = total;
      if (Number.isFinite(secs)) this.lastEpochSec = secs;
      if (Number.isFinite(loss)) {
        this.loss = loss;
        if (this.bestLoss == null || loss < this.bestLoss) this.bestLoss = loss;
        this.pushMetric({ epoch, loss });
      }
      return;
    }

    const mPaused = RE_PAUSED.exec(line);
    if (mPaused) {
      this.pausedAt = mPaused[1];
      return;
    }

    const mCkptAt = RE_CHECKPOINT_AT.exec(line);
    if (mCkptAt) {
      this.lastCheckpoint = mCkptAt[1];
      return;
    }

    // Checkpoint intermédiaire — informatif, ne remplace pas outputPath
    const mCkpt = RE_CHECKPOINT.exec(line);
    if (mCkpt) {
      this.lastCheckpoint = mCkpt[1];
      return;
    }

    // Adaptateur final — c'est LUI le résultat à charger pour l'inférence
    const mFinal = RE_FINAL.exec(line);
    if (mFinal) {
      this.outputPath = mFinal[1];
      return;
    }

    const mVerified = RE_VERIFIED.exec(line);
    if (mVerified) {
      this.trainableParams = Number(mVerified[1].replace(/,/g, '')) || null;
      return;
    }

    if (RE_FAILED.test(line)) {
      this.lastError = line.trim();
    }
  }

  /** Estimation du temps restant à partir de la durée de la dernière époque. */
  private computeEta(): number | null {
    if (!this.lastEpochSec || !this.totalEpochs || this.epoch <= 0) return null;
    const remaining = this.totalEpochs - this.epoch;
    if (remaining <= 0) return 0;
    return Math.round(remaining * this.lastEpochSec);
  }

  private pushMetric(point: TrainingMetricPoint): void {
    this.metrics.push(point);
    if (this.metrics.length > MAX_METRIC_POINTS) {
      // Décimation : on garde un point sur deux pour ne pas gonfler la réponse
      this.metrics = this.metrics.filter((_, i) => i % 2 === 0);
    }
  }

  private appendLog(text: string): void {
    this.log += text;
    if (this.log.length > MAX_LOG_CHARS) {
      this.log = this.log.slice(this.log.length - MAX_LOG_CHARS);
    }
  }

  private tailLog(chars: number): string {
    return this.log.slice(Math.max(0, this.log.length - chars));
  }

  /* -- Pause -------------------------------------------------------------- */

  /**
   * Asks the run to stop after the current epoch: train.py sees the file, saves a checkpoint (even off the save schedule)
   * and exits; the state then becomes 'paused' with that checkpoint in lastCheckpoint.
   */
  pause(): boolean {
    if (!this.process || !this.isRunning() || !this.pauseFile) return false;
    if (!this.pauseRequested) {
      writeFileSync(this.pauseFile, String(Date.now()));
      this.pauseRequested = true;
      this.message = "Pause demandée — fin de l'époque en cours, puis checkpoint";
    }
    return true;
  }

  private clearPauseFile(): void {
    if (!this.pauseFile) return;
    try { rmSync(this.pauseFile, { force: true }); } catch { /* already gone */ }
    this.pauseFile = null;
  }

  /* -- Arrêt --------------------------------------------------------------- */

  stop(): boolean {
    if (!this.process) return false;
    this.state = 'stopped';
    this.message = 'Arrêt en cours...';
    this.process.kill('SIGTERM');

    // Filet de sécurité : SIGKILL si le process ne rend pas la main
    const proc = this.process;
    setTimeout(() => {
      if (proc && !proc.killed) {
        try { proc.kill('SIGKILL'); } catch { /* déjà mort */ }
      }
    }, 8000);

    return true;
  }
}

export const trainingRunner = new TrainingRunner();
