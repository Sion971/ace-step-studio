// Lists shown by name (workspaces, playlists) in alphabetical order: accents and case ignored ("Été" with "ete"),
// numbers in their natural order ("Démo 2" before "Démo 10").

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

export const sortByName = <T extends { name: string }>(items: readonly T[]): T[] =>
  [...items].sort((a, b) => collator.compare(a.name.trim(), b.name.trim()));
