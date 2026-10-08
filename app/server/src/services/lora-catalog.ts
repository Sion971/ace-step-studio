// services/lora-catalog.ts
//
// The catalog of LoRA that the Studio offers to install: a JSON file in the repository (app/server/catalog/lora-catalog.json), maintained by hand.
// An entry is a pointer, never a copy: the weights always come from the author's own repository on Hugging Face, to the user's own disk.
//
// The file is read as untrusted, because a catalog is exactly what people send changes to: an entry that is not valid is skipped and reported,
// never repaired, and never lets the others down. An entry can PIN what it promises: the commit and the checksum of the weights. A pinned
// entry cannot be changed under the user's feet by an update of the author's repository: the install refuses if the content is not the one that
// was checked.

import { readFileSync } from 'node:fs';
import { parseRepoRef, sanitizeName, safeRepoPath, type LoraCard } from './lora-hub.js';
import { boundedInteger, boundedNumber, normalizeSha, plain, plainList } from './lora-text.js';

export const CATALOG_SCHEMA = 1;
export const MAX_ENTRIES = 500;

export interface CatalogEntry {
  /** Lowercase letters, digits, ".", "_", "-": it is what the install route is called with. */
  id: string;
  repo: string;
  /** The weights file, when the repository has several; null lets the install choose the only one. */
  file: string | null;
  /** A commit (7 to 40 hex digits): what was checked. Null follows the repository's main branch. */
  revision: string | null;
  /** The sha256 of the weights that were checked. Null: not pinned. */
  sha256: string | null;
  name: string;
  description: string | null;
  author: string | null;
  license: string | null;
  /** Free text, read by lora-compat.ts: "AceStep v1.5 Turbo (2B)". */
  baseModel: string | null;
  genre: string | null;
  tags: string[];
  triggerWord: string | null;
  recommended: { scale: number | null; steps: number | null; guidance: number | null; shift: number | null };
  sizeBytes: number | null;
  /** When and by whom this entry was installed and checked. Null: nobody has. */
  verified: { date: string; note: string | null } | null;
}

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const COMMIT = /^[0-9a-f]{7,40}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const asObject = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Either the entry, or the single reason it was refused. */
function parseEntry(raw: unknown): { entry: CatalogEntry } | { problem: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { problem: 'it is not an object' };
  const e = asObject(raw);

  if (typeof e.id !== 'string' || !ID.test(e.id)) return { problem: 'id must be lowercase letters, digits, ".", "_" or "-", 64 characters at most' };
  if (typeof e.repo !== 'string') return { problem: 'repo must be "owner/name"' };
  let repo: string;
  try {
    const ref = parseRepoRef(e.repo);
    if (ref.revision !== undefined || ref.repo !== e.repo) return { problem: 'repo must be "owner/name", not a link: the commit goes in "revision"' };
    repo = ref.repo;
  } catch {
    return { problem: 'repo is not a valid "owner/name"' };
  }

  let file: string | null = null;
  if (e.file !== undefined && e.file !== null) {
    if (typeof e.file !== 'string' || e.file.length > 200 || !safeRepoPath(e.file) || !/\.safetensors$/i.test(e.file)) return { problem: 'file must be a .safetensors path inside the repository' };
    file = e.file;
  }

  let revision: string | null = null;
  if (e.revision !== undefined && e.revision !== null) {
    if (typeof e.revision !== 'string' || !COMMIT.test(e.revision)) return { problem: 'revision must be a commit (7 to 40 lowercase hex digits), not a branch: a branch moves' };
    revision = e.revision;
  }

  let sha256: string | null = null;
  if (e.sha256 !== undefined && e.sha256 !== null) {
    sha256 = normalizeSha(e.sha256);
    if (!sha256) return { problem: 'sha256 must be 64 hex digits' };
  }

  const name = plain(e.name, 80);
  if (!name) return { problem: 'name is required' };

  let verified: CatalogEntry['verified'] = null;
  if (e.verified !== undefined && e.verified !== null) {
    const v = asObject(e.verified);
    if (typeof v.date !== 'string' || !DAY.test(v.date)) return { problem: 'verified must be { "date": "YYYY-MM-DD", "note": "..." } or null' };
    verified = { date: v.date, note: plain(v.note, 160) };
  }

  const rec = asObject(e.recommended);
  return {
    entry: {
      id: e.id,
      repo,
      file,
      revision,
      sha256,
      name,
      description: plain(e.description, 400),
      author: plain(e.author, 80),
      license: plain(e.license, 64),
      baseModel: plain(e.baseModel, 120),
      genre: plain(e.genre, 60),
      tags: plainList(e.tags, 10, 40),
      triggerWord: plain(e.triggerWord, 60),
      recommended: {
        scale: boundedNumber(rec.scale, 0, 4),
        steps: boundedInteger(rec.steps, 1, 200),
        guidance: boundedNumber(rec.guidance, 0, 50),
        shift: boundedNumber(rec.shift, 0, 20),
      },
      sizeBytes: boundedInteger(e.sizeBytes, 0, 2 ** 40),
      verified,
    },
  };
}

export interface ParsedCatalog {
  entries: CatalogEntry[];
  /** One line per thing that was refused, for whoever maintains the file. */
  problems: string[];
}

export function parseCatalog(text: string): ParsedCatalog {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { entries: [], problems: ['The catalog is not valid JSON.'] };
  }
  const root = asObject(raw);
  if (root.schema !== CATALOG_SCHEMA) return { entries: [], problems: [`The catalog must have "schema": ${CATALOG_SCHEMA}.`] };
  if (!Array.isArray(root.entries)) return { entries: [], problems: ['The catalog must have an "entries" list.'] };

  const entries: CatalogEntry[] = [];
  const problems: string[] = [];
  const ids = new Set<string>();
  const targets = new Set<string>();
  root.entries.forEach((raw, index) => {
    const label = `entries[${index}]${typeof asObject(raw).id === 'string' ? ` ("${String(asObject(raw).id).slice(0, 40)}")` : ''}`;
    if (index >= MAX_ENTRIES) {
      if (index === MAX_ENTRIES) problems.push(`The catalog is limited to ${MAX_ENTRIES} entries: the rest was ignored.`);
      return;
    }
    const parsed = parseEntry(raw);
    if ('problem' in parsed) return void problems.push(`${label}: ${parsed.problem}.`);
    const { entry } = parsed;
    const target = `${entry.repo}#${entry.file ?? ''}#${entry.revision ?? ''}`;
    if (ids.has(entry.id)) return void problems.push(`${label}: the id is already used by an earlier entry.`);
    if (targets.has(target)) return void problems.push(`${label}: the same weights are already listed by an earlier entry.`);
    ids.add(entry.id);
    targets.add(target);
    entries.push(entry);
  });
  return { entries, problems };
}

export function loadCatalogFile(filePath: string): ParsedCatalog {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf-8');
  } catch {
    return { entries: [], problems: ['The catalog file could not be read.'] };
  }
  return parseCatalog(text);
}

/**
 * A catalog entry written from what an inspection found, pinned to the commit and the checksum that were seen: the maintainer pastes it into the
 * catalog file and sets "verified" once the LoRA has been installed and heard. Null while the caller still has to choose between weights.
 */
export function catalogEntryFromCard(card: LoraCard): CatalogEntry | null {
  if (!card.selected) return null;
  const repoName = card.repo.split('/')[1];
  const side = card.sidecar;
  const owner = card.repo.split('/')[0];
  return {
    id: sanitizeName(repoName).toLowerCase(),
    repo: card.repo,
    file: card.selected.name,
    revision: card.revision,
    sha256: card.selected.sha256,
    name: side?.name ?? repoName,
    description: side?.description ? plain(side.description, 400) : null,
    author: side?.author ?? owner,
    license: card.license,
    baseModel: side?.baseModelRequired ?? card.baseModel[0] ?? card.adapter?.baseModel ?? null,
    genre: side?.genre ?? null,
    tags: (side?.tags ?? []).slice(0, 10),
    triggerWord: side?.triggerWord ?? null,
    recommended: {
      scale: side?.recommended.scale ?? null,
      steps: side?.recommended.steps ?? null,
      guidance: side?.recommended.guidance ?? null,
      shift: side?.recommended.shift ?? null,
    },
    sizeBytes: card.selected.size,
    verified: null,
  };
}
