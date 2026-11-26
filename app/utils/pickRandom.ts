// `count` different items drawn at random from `items`, each item with the same chance (a partial Fisher–Yates
// shuffle). Sorting with `() => Math.random() - 0.5` is not a fair shuffle: the browser's sort favours the items
// at the start of the list, so with an alphabetical list the same first styles kept coming back.

export function pickRandom<T>(items: readonly T[], count: number, random: () => number = Math.random): T[] {
  const pool = [...items];
  const n = Math.min(count, pool.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}
