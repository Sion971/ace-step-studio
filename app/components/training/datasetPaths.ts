/**
 * Chemins de fichier du jeu de donnees : le nom saisi decide du nom du fichier .json,
 * le dossier choisi par l'utilisateur est conserve.
 */
const INVALID_FILE_CHARS = /[\\/:*?"<>|]+/g;

export function safeDatasetFileName(name: string): string {
  return name.trim().replace(INVALID_FILE_CHARS, '_').replace(/^\.+|[. ]+$/g, '');
}

/** Chemin d'enregistrement pour `name` : meme dossier que `currentPath`, nouveau nom de fichier. */
export function savePathForName(currentPath: string, name: string): string {
  const file = safeDatasetFileName(name);
  if (!file) return currentPath;
  const cut = Math.max(currentPath.lastIndexOf('/'), currentPath.lastIndexOf('\\'));
  const dir = cut >= 0 ? currentPath.slice(0, cut + 1) : './datasets/';
  return `${dir}${file}.json`;
}
