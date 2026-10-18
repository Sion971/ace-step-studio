// Installs the LoRA of the catalog (or of the candidates) FROM THE REAL HUGGING FACE, with the code the Studio itself uses, into a temporary folder,
// and reports what happened. Run it on a machine that can reach huggingface.co, from app/server:
//
//   npx tsx src/scripts/verify-lora-catalog.ts                      check the candidates (catalog/lora-catalog.candidates.json): inspect, download, verify checksum
//   npx tsx src/scripts/verify-lora-catalog.ts --promote            ... and move those that passed into the shipped catalog, pinned (commit, checksum, size, file)
//   npx tsx src/scripts/verify-lora-catalog.ts --shipped            check the shipped catalog instead (are the pins still good?)
//   --only id,id   only these ids        --inspect-only   no download        --keep   keep the downloaded LoRA (default: temporary folder, removed)
//
// A private or gated repository needs HF_TOKEN in the environment. "Passed" means: the files were found, the weights match the checksum the Hub publishes
// (or a checksum was measured), and the folder holds what the engine needs. It does NOT mean the LoRA was listened to: that stays the maintainer's call.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LoraHub, LoraHubError, type LoraCard } from '../services/lora-hub.js';
import { loadCatalogFile, pinEntry, type CatalogEntry } from '../services/lora-catalog.js';
import { requiredBase } from '../services/lora-compat.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
};
// --catalog / --candidates: other files (used to try the script against a fake Hub); HF_ENDPOINT: another Hub address.
const CATALOG = path.resolve(option('--catalog') ?? path.join(here, '../../catalog/lora-catalog.json'));
const CANDIDATES = path.resolve(option('--candidates') ?? path.join(here, '../../catalog/lora-catalog.candidates.json'));
const only = option('--only') ? new Set((option('--only') as string).split(',').map((s) => s.trim())) : null;

const mb = (n: number | null) => (n === null ? '?' : `${(n / 1024 ** 2).toFixed(1)} MB`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Row {
  id: string;
  status: 'OK' | 'FAIL' | 'SKIPPED';
  detail: string;
  entry?: CatalogEntry;
}

async function main(): Promise<void> {
  const source = flag('--shipped') ? CATALOG : CANDIDATES;
  const parsed = loadCatalogFile(source);
  parsed.problems.forEach((p) => console.log(`! ${p}`));
  const entries = parsed.entries.filter((e) => !only || only.has(e.id));
  if (entries.length === 0) {
    const listed = parsed.entries.length;
    throw new Error(
      listed === 0
        ? `No entry in ${source}.${flag('--shipped') ? '' : ' If a previous run used --promote, the candidates that passed were moved into catalog/lora-catalog.json: look at `git status` and commit that file.'}`
        : `None of the ${listed} entries of ${source} matches --only.`,
    );
  }

  const loraDir = mkdtempSync(path.join(tmpdir(), 'lora-verify-'));
  const hub = new LoraHub({ loraDir, token: process.env.HF_TOKEN, endpoint: process.env.HF_ENDPOINT });
  const date = new Date().toISOString().slice(0, 10);
  const rows: Row[] = [];
  console.log(`Checking ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} of ${path.basename(source)} against ${process.env.HF_ENDPOINT || 'https://huggingface.co'}\n`);

  for (const entry of entries) {
    console.log(`── ${entry.id}  (${entry.repo})`);
    try {
      const card: LoraCard = await hub.inspect(entry.repo, { file: entry.file ?? undefined, revision: entry.revision ?? undefined });
      if (card.needsChoice || !card.selected) {
        rows.push({ id: entry.id, status: 'FAIL', detail: `several weights files, set "file": ${card.weights.map((w) => w.name).join(', ')}` });
        console.log(`   several .safetensors files, none chosen: ${card.weights.map((w) => w.name).join(', ')}\n`);
        continue;
      }
      const required = requiredBase(card);
      console.log(`   commit ${card.revision.slice(0, 12)} · ${card.selected.name} · ${mb(card.selected.size)} · sha256 ${card.selected.sha256 ? card.selected.sha256.slice(0, 12) + '…' : 'not published'}`);
      console.log(`   license ${card.license ?? 'not declared'} · adapter ${card.adapter?.peftType ?? '?'} rank ${card.adapter?.rank ?? '?'} · base "${required?.label ?? 'unknown'}" (${required?.family ?? '?'}/${required?.size ?? '?'})`);
      if (card.sidecar?.triggerWord) console.log(`   trigger word (author's metadata file): ${card.sidecar.triggerWord}`);
      card.warnings.forEach((w) => console.log(`   ! ${w}`));

      if (flag('--inspect-only')) {
        rows.push({ id: entry.id, status: 'SKIPPED', detail: 'inspected only' });
        console.log('');
        continue;
      }

      const job = await hub.startInstall(entry.repo, {
        file: card.selected.name,
        revision: card.revision,
        expectedSha256: card.selected.sha256 ?? undefined,
        name: entry.id,
      });
      let last = -1;
      for (;;) {
        const j = hub.getJob(job.id);
        if (!j) throw new Error('the install job disappeared');
        if (j.state === 'done') break;
        if (j.state === 'failed') throw new LoraHubError(j.error?.message ?? 'install failed', 500, j.error?.code ?? 'install_failed');
        const pct = j.bytesTotal ? Math.floor((100 * j.bytesDone) / j.bytesTotal) : Math.floor(j.bytesDone / 1024 ** 2);
        if (pct !== last && (!j.bytesTotal || pct % 10 === 0)) {
          process.stdout.write(`   ${j.state} ${j.bytesTotal ? pct + '%' : pct + ' MB'}\r`);
          last = pct;
        }
        await sleep(500);
      }
      const folder = path.join(loraDir, entry.id.replace(/\./g, '_'));
      const missing = ['adapter_model.safetensors', 'adapter_config.json', 'lora_hub.json'].filter((f) => !existsSync(path.join(folder, f)));
      if (missing.length > 0) throw new Error(`the installed folder lacks ${missing.join(', ')}`);
      const installed = hub.listInstalled().find((i) => i.repo === card.repo && i.file === card.selected?.name) ?? null;
      console.log(`   installed, checksum ${installed?.sha256 ? installed.sha256.slice(0, 12) + '…' : '?'} verified                `);

      const pinned = pinEntry(entry, card, installed?.sha256 ?? null, date, 'Downloaded and checksum-verified by verify-lora-catalog; not listened to.');
      if ('problem' in pinned) {
        rows.push({ id: entry.id, status: 'FAIL', detail: pinned.problem });
        console.log(`   cannot be pinned: ${pinned.problem}\n`);
        continue;
      }
      rows.push({ id: entry.id, status: 'OK', detail: `${card.revision.slice(0, 12)} · ${mb(pinned.entry.sizeBytes)}`, entry: pinned.entry });
      console.log('   OK\n');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      rows.push({ id: entry.id, status: 'FAIL', detail: message });
      console.log(`   FAIL: ${message}\n`);
    }
  }

  console.log('── Summary');
  for (const r of rows) console.log(`   ${r.status.padEnd(7)} ${r.id.padEnd(30)} ${r.detail}`);

  const passed = rows.filter((r): r is Row & { entry: CatalogEntry } => r.status === 'OK' && !!r.entry);
  if (flag('--promote') && !flag('--shipped')) {
    if (passed.length === 0) console.log('\nNothing to promote.');
    else {
      const shipped = JSON.parse(readFileSync(CATALOG, 'utf-8')) as { schema: number; entries: Record<string, unknown>[] };
      const known = new Set(shipped.entries.map((e) => e.id));
      const added = passed.filter((p) => !known.has(p.entry.id));
      shipped.entries.push(...added.map((p) => p.entry as unknown as Record<string, unknown>));
      writeFileSync(CATALOG, JSON.stringify(shipped, null, 2) + '\n');
      const left = JSON.parse(readFileSync(CANDIDATES, 'utf-8')) as { schema: number; entries: { id: string }[] };
      left.entries = left.entries.filter((e) => !passed.some((p) => p.entry.id === e.id));
      writeFileSync(CANDIDATES, JSON.stringify(left, null, 2) + '\n');
      console.log(`\nPromoted ${added.length} entr${added.length === 1 ? 'y' : 'ies'} into catalog/lora-catalog.json (pinned, "verified" dated today, "not listened to"). Listen to them in the Studio, then edit the note.`);
      console.log('Then commit BOTH files:  git add app/server/catalog && git commit -m "Catalogue LoRA : LoRA verifies"');
    }
  } else if (passed.length > 0 && !flag('--shipped')) {
    console.log('\nRun again with --promote to pin these into the shipped catalog.');
  }

  if (flag('--keep')) console.log(`\nDownloaded LoRA kept in ${loraDir}`);
  else rmSync(loraDir, { recursive: true, force: true });
  process.exitCode = rows.some((r) => r.status === 'FAIL') ? 1 : 0;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
