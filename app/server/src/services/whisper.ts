// services/whisper.ts
//
// Transcription of the lyrics with the `whisper` command (openai-whisper), when it is installed.
import path from 'path';
import os from 'os';
import { promises as fs } from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { structureLyrics, type TimedLine } from './lyrics-structure.js';

const EXE = process.platform === 'win32' ? '.exe' : '';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/** Where `whisper` can be: WHISPER_PATH, the Studio's own Python environment (where `pip install openai-whisper` puts it), then PATH. */
export function whisperSearchDirs(env: NodeJS.ProcessEnv = process.env, root: string = REPO_ROOT): string[] {
  const binDir = process.platform === 'win32' ? 'Scripts' : 'bin';
  const dirs: string[] = [];
  if (env.WHISPER_PATH) dirs.push(env.WHISPER_PATH);
  for (const venv of ['.venv', 'venv', 'env']) dirs.push(path.join(root, venv, binDir));
  dirs.push(path.join(root, 'python_embeded', 'Scripts'), path.join(root, 'python', 'Scripts'));
  dirs.push(...(env.PATH || '').split(path.delimiter).filter(Boolean));
  return dirs;
}

let warnedMissing = false;

export const findWhisperExecutable = async (): Promise<string | null> => {
  if (process.env.WHISPER_CMD) return process.env.WHISPER_CMD;
  for (const dir of whisperSearchDirs()) {
    for (const name of EXE ? ['whisper.exe', 'whisper'] : ['whisper']) {
      const candidate = path.join(dir, name);
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        // ignore
      }
    }
  }
  if (!warnedMissing) {
    warnedMissing = true;
    console.warn('[Whisper] not found: lyrics cannot be transcribed. Install it in the Studio environment (pip install openai-whisper) or set WHISPER_PATH / WHISPER_CMD.');
  }
  return null;
};

export interface WhisperResult {
  /** The lyrics, one line per sung phrase, with [Verse] / [Chorus]... when the pauses and repetitions allow ("" when nothing was heard). */
  text: string;
  /** The language Whisper recognised ("fr", "en"...), or "". */
  language: string;
}

/** What Whisper's JSON file says: the lyrics (phrases, grouped into sections) and the language. */
export function parseWhisperJson(raw: string): WhisperResult | null {
  try {
    const data = JSON.parse(raw) as { text?: unknown; language?: unknown; segments?: Array<{ text?: unknown; start?: unknown; end?: unknown }> };
    const timed: TimedLine[] = Array.isArray(data.segments)
      ? data.segments.map((s) => ({ start: Number(s?.start), end: Number(s?.end), text: typeof s?.text === 'string' ? s.text : '' }))
      : [];
    const structured = structureLyrics(timed);
    const text = structured || (timed.length ? '' : typeof data.text === 'string' ? data.text.trim() : '');
    return { text, language: typeof data.language === 'string' ? data.language : '' };
  } catch {
    return null;
  }
}

/** null: Whisper is missing or failed. A result with an empty text: it ran and heard no words. */
export const transcribeWithWhisperDetailed = async (buffer: Buffer, originalFilename: string, signal?: AbortSignal): Promise<WhisperResult | null> => {
  const whisperCmd = await findWhisperExecutable();
  if (!whisperCmd) return null;

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'whisper-'));
  const ext = path.extname(originalFilename) || '.mp3';
  const inputPath = path.join(tempDir, `input${ext}`);
  const outputDir = path.join(tempDir, 'out');

  try {
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(inputPath, buffer);

    const args = [
      inputPath,
      '--model', 'base',
      '--output_format', 'json',
      '--output_dir', outputDir,
      '--fp16', 'False'
    ];

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(whisperCmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let errTail = '';
      proc.stderr?.on('data', (d: Buffer) => { errTail = (errTail + d.toString()).slice(-800); });
      const handleAbort = () => {
        proc.kill('SIGTERM');
        reject(new Error('Transcription cancelled'));
      };
      if (signal) {
        if (signal.aborted) {
          handleAbort();
          return;
        }
        signal.addEventListener('abort', handleAbort, { once: true });
      }
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (signal) {
          signal.removeEventListener('abort', handleAbort);
        }
        if (code === 0) resolve();
        else reject(new Error(`Whisper exited with code ${code}${errTail.trim() ? `: ${errTail.trim().split('\n').slice(-3).join(' | ')}` : ''}`));
      });
    });

    const files = await fs.readdir(outputDir);
    const jsonFile = files.find((file) => file.endsWith('.json'));
    if (!jsonFile) return null;
    return parseWhisperJson(await fs.readFile(path.join(outputDir, jsonFile), 'utf8'));
  } catch (error) {
    console.warn('Whisper transcription failed:', error);
    return null;
  } finally {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
};

/** The lyrics only (what the upload route has always returned); null when missing, failed or nothing heard. */
export const transcribeWithWhisper = async (buffer: Buffer, originalFilename: string, signal?: AbortSignal): Promise<string | null> => {
  const result = await transcribeWithWhisperDetailed(buffer, originalFilename, signal);
  return result?.text || null;
};
