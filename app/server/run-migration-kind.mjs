// Migration : separation reelle entre "Playlist" et "Espace de travail"
// (voir session du 24/08/2026). Remplace l'ancien migration_playlists_kind.sql
// ecrit par erreur en syntaxe PostgreSQL — ce projet utilise SQLite via
// better-sqlite3 (confirme dans app/server/src/db/pool.ts), pas Postgres.
//
// Idempotent : peut etre relance sans risque, a la main ou automatiquement
// par install.sh a chaque (re)installation — voir TROUBLESHOOTING.md.
// Correctif du 26/08/2026 : la version precedente verifiait la presence
// d'un fichier de sauvegarde AVANT de verifier si la colonne existait deja,
// ce qui faisait echouer (exit 1) toute relance automatisee des qu'une
// premiere sauvegarde existait — meme quand la migration etait deja faite
// depuis longtemps. install.sh utilisant `set -e`, ca arretait net toute
// l'installation a cette etape, sans jamais atteindre les etapes suivantes.
//
// Usage :
//   cd app/server
//   node run-migration-kind.mjs
//
// Utilise la MEME bibliotheque (better-sqlite3) que le serveur lui-meme,
// pour eviter tout risque d'incompatibilite avec un sqlite3 systeme
// installe a une version differente.

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync, copyFileSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Meme chemin que DATABASE_PATH dans .env — ajuster ici si le .env reel
// utilise un chemin different de la valeur par defaut du .env.example.
const DB_PATH = path.join(__dirname, 'data', 'acestep.db');

if (!existsSync(DB_PATH)) {
  // Cas normal sur une premiere installation, pas une erreur : la base
  // n'existe qu'a partir du premier demarrage reel du serveur (run.sh),
  // jamais creee par install.sh lui-meme. Une base ainsi creee aura DEJA
  // le bon schema des le depart (colonne "kind" incluse) — rien a migrer,
  // par definition, pour une base qui n'existe pas encore. Corrige apres
  // un cas reel : traite auparavant comme une erreur fatale (exit 1),
  // ce qui arretait l'installation entiere a cette etape via `set -e`
  // dans install.sh, sur ce qui n'etait pourtant qu'une situation
  // parfaitement normale.
  console.log(`Base de donnees pas encore creee (${DB_PATH}) — normal sur une premiere installation.`);
  console.log('Elle sera creee avec le schema a jour au premier demarrage (run.sh) ; rien a migrer.');
  process.exit(0);
}

const BACKUP_PATH = `${DB_PATH}.backup-before-kind-migration`;
const db = new Database(DB_PATH);

try {
  // Verifie D'ABORD si la colonne existe deja — la vraie question qui
  // determine si un travail reste a faire, plutot que de deduire l'etat de
  // la migration a partir d'un simple fichier de sauvegarde (un artefact
  // d'un lancement precedent, pas une source de verite fiable).
  const columns = db.prepare("PRAGMA table_info(playlists)").all();
  const hasKind = columns.some((c) => c.name === 'kind');

  if (hasKind) {
    console.log('La colonne "kind" existe deja — rien a faire.');
  } else {
    // Migration reellement necessaire : sauvegarde d'abord (sauf si une
    // sauvegarde existe deja depuis une tentative precedente incomplete —
    // rare, mais ne jamais l'ecraser silencieusement dans ce cas).
    if (!existsSync(BACKUP_PATH)) {
      copyFileSync(DB_PATH, BACKUP_PATH);
      console.log(`Sauvegarde creee : ${BACKUP_PATH}`);
    } else {
      console.log(`Sauvegarde deja presente (tentative precedente incomplete ?) : ${BACKUP_PATH}`);
    }

    // Pas de contrainte CHECK au niveau SQL : SQLite ne supporte pas l'ajout
    // de contrainte via ALTER TABLE apres coup (il faudrait reconstruire
    // toute la table, trop invasif pour ce cas). Le serveur (playlists.ts)
    // valide deja la valeur a l'insertion — deuxieme barriere jugee
    // suffisante plutot que de risquer la reconstruction de table.
    db.exec(`
      ALTER TABLE playlists ADD COLUMN kind TEXT NOT NULL DEFAULT 'playlist';
    `);
    console.log('Colonne "kind" ajoutee (defaut : \'playlist\' pour toutes les lignes existantes).');

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_playlists_user_kind ON playlists (user_id, kind);
    `);
    console.log('Index cree.');
  }

  // Verification finale : compte par type, pour confirmer que rien n'a
  // bascule silencieusement vers 'workspace'.
  const counts = db.prepare(
    "SELECT kind, COUNT(*) as n FROM playlists GROUP BY kind"
  ).all();
  console.log('\nRepartition actuelle :');
  for (const row of counts) {
    console.log(`  ${row.kind}: ${row.n}`);
  }

  console.log('\nMigration terminee avec succes.');
} catch (err) {
  console.error('\nErreur pendant la migration :', err.message);
  if (existsSync(BACKUP_PATH)) {
    console.error(`La sauvegarde reste disponible : ${BACKUP_PATH}`);
    console.error(`Pour restaurer : cp "${BACKUP_PATH}" "${DB_PATH}"`);
  }
  process.exit(1);
} finally {
  db.close();
}
