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
