/** Seeds réellement utilisés par le moteur ("123, 456" — un par élément du lot). */
export function parseSeeds(raw: unknown): number[] {
  if (typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s))
    .map(Number);
}

/** Paramètres à enregistrer pour la piste `index` : le seed réel remplace -1 / aléatoire. */
export function paramsWithSeed<T extends object>(params: T, seeds: number[] | undefined, index: number): T {
  const seed = seeds?.[index];
  if (seed === undefined) return params;
  return { ...params, seed };
}
