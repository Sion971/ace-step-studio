// Migration : separation reelle entre "Playlist" et "Espace de travail"
// (voir session du 24/08/2026). Remplace l'ancien migration_playlists_kind.sql
// ecrit par erreur en syntaxe PostgreSQL — ce projet utilise SQLite via
// better-sqlite3 (confirme dans app/server/src/db/pool.ts), pas Postgres.
//
// A lancer UNE SEULE FOIS, depuis app/server/, avant de deployer le nouveau
// code serveur (playlists.ts) qui lit/ecrit cette colonne.
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
  console.error(`Base introuvable : ${DB_PATH}`);
  console.error('Verifie DATABASE_PATH dans ton .env reel — si le chemin');
  console.error('differe de la valeur par defaut, ajuste DB_PATH ci-dessus');
  console.error('avant de relancer ce script.');
  process.exit(1);
}

// Sauvegarde automatique avant toute modification — un simple fichier a
// copier, aucun outil special necessaire pour SQLite.
const BACKUP_PATH = `${DB_PATH}.backup-before-kind-migration`;
if (existsSync(BACKUP_PATH)) {
  console.error(`Une sauvegarde existe deja : ${BACKUP_PATH}`);
  console.error('Ce script a peut-etre deja tourne. Verifie avant de continuer :');
  console.error(`  sqlite3 "${DB_PATH}" "PRAGMA table_info(playlists);"`);
  console.error('(ou lance directement la verification en bas de ce script)');
  process.exit(1);
}
copyFileSync(DB_PATH, BACKUP_PATH);
console.log(`Sauvegarde creee : ${BACKUP_PATH}`);

const db = new Database(DB_PATH);

try {
  // Verifie si la colonne existe deja (idempotence manuelle — SQLite ne
  // garantit pas ADD COLUMN IF NOT EXISTS selon la version bundled).
  const columns = db.prepare("PRAGMA table_info(playlists)").all();
  const hasKind = columns.some((c) => c.name === 'kind');

  if (hasKind) {
    console.log('La colonne "kind" existe deja — rien a faire.');
  } else {
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
  console.error(`La sauvegarde reste disponible : ${BACKUP_PATH}`);
  console.error(`Pour restaurer : cp "${BACKUP_PATH}" "${DB_PATH}"`);
  process.exit(1);
} finally {
  db.close();
}
