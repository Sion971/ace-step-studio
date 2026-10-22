// services/generation-errors.ts
//
// Classe l'echec d'une generation. ACE-Step coupe toute generation apres ACESTEP_GENERATION_TIMEOUT
// secondes (600 par defaut) et son message dit : « ... This usually means the GPU ran out of VRAM or the
// diffusion loop stalled ». Le Studio testait le mot « VRAM » pour afficher « NOT ENOUGH GPU MEMORY » :
// un simple delai depasse sur un PROCESSEUR (aucun GPU) etait donc presente comme un manque de memoire.
// Le delai doit etre teste en premier.

export type GenerationFailureKind = 'timeout' | 'out-of-memory' | 'other';

const TIMEOUT_PATTERN = /timed out after (\d+) seconds/i;

export function classifyGenerationFailure(message: string): GenerationFailureKind {
  if (TIMEOUT_PATTERN.test(message)) return 'timeout';
  if (message.includes('VRAM') || message.includes('Insufficient free')) return 'out-of-memory';
  return 'other';
}

/** Message clair pour un delai depasse : ce n'est pas forcement un manque de memoire. */
export function friendlyTimeoutMessage(message: string): string {
  const seconds = TIMEOUT_PATTERN.exec(message)?.[1] ?? '?';
  return (
    `Generation timed out after ${seconds} seconds. This is a time limit, not necessarily a memory problem: ` +
    `on a CPU or a slow GPU, generation can take much longer. Restart with ACESTEP_GENERATION_TIMEOUT=3600 ` +
    `(seconds), or reduce the duration.`
  );
}

// Une erreur CUDA « collante » (Sticky error, acces memoire illegal, assertion du noyau...) rend le contexte CUDA du moteur
// inutilisable : toutes les generations suivantes echouent tant que le moteur n'est pas relance. Un simple manque de memoire
// (« CUDA out of memory. Tried to allocate... ») ne l'est pas : la generation suivante peut reussir.
const FATAL_CUDA_PATTERNS: RegExp[] = [
  /sticky error/i,
  /CUDA error: (an illegal memory access|device-side assert|unspecified launch failure|misaligned address|uncorrectable ECC|the launch timed out|the launch failed)/i,
  /CUDA_ERROR_(ILLEGAL_ADDRESS|LAUNCH_FAILED|ASSERT|ECC_UNCORRECTABLE|MISALIGNED_ADDRESS|HARDWARE_STACK_ERROR|ILLEGAL_INSTRUCTION)/,
];

/** True when the CUDA context of the engine is lost: only a restart of the engine brings the card back. */
export function isFatalCudaError(message: string): boolean {
  return FATAL_CUDA_PATTERNS.some((pattern) => pattern.test(message));
}

/** Any error raised by the CUDA runtime or its libraries (a plain "CUDA out of memory" allocation failure is not one). */
export function isCudaError(message: string): boolean {
  return /CUDA error|AcceleratorError|CUBLAS_STATUS|CUDNN_STATUS/i.test(message);
}

/**
 * Decides when the engine must be restarted after failed generations: at once for a fatal CUDA error, or when `limit`
 * generations in a row failed with a CUDA error (the later ones of a lost context do not always repeat "Sticky error").
 */
export class CudaFailureTracker {
  private consecutive = 0;

  constructor(private readonly limit = 2) {}

  /** A generation failed with `message`. True when the engine has to be restarted. */
  failed(message: string): boolean {
    if (isFatalCudaError(message)) {
      this.consecutive = 0;
      return true;
    }
    this.consecutive = isCudaError(message) ? this.consecutive + 1 : 0;
    if (this.consecutive >= this.limit) {
      this.consecutive = 0;
      return true;
    }
    return false;
  }

  /** A generation went through: the card works. */
  succeeded(): void {
    this.consecutive = 0;
  }
}

/** What the person sees on the failed job: the cause is the card, not their request, and the next generation is not lost. */
export function friendlyCudaRestartMessage(message: string): string {
  const firstLine = message.split('\n')[0].trim();
  return (
    'The graphics card stopped working during this generation (CUDA error). The engine restarts by itself; ' +
    'the generations waiting in the queue start as soon as it is back (1 to 2 minutes). Try this one again afterwards.\n\n' +
    firstLine
  );
}
