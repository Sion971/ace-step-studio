// services/whisper.ts
//
// Transcription of the lyrics with the `whisper` command (openai-whisper), when it is installed.
import path from 'path';
import os from 'os';
import { promises as fs } from 'fs';
import { spawn } from 'child_process';

export const findWhisperExecutable = async (): Promise<string | null> => {
  if (process.env.WHISPER_CMD) return process.env.WHISPER_CMD;
  const customPath = process.env.WHISPER_PATH;
  if (customPath) {
    const candidate = path.join(customPath, 'whisper');
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // ignore
    }
  }

  const pathEntries = (process.env.PATH || '').split(path.delimiter);
  for (const entry of pathEntries) {
    const candidate = path.join(entry, 'whisper');
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // ignore
    }
  }
  return null;
};

export interface WhisperResult {
  /** One line per sung phrase ("" when nothing was heard, e.g. an instrumental). */
  text: string;
  /** The language Whisper recognised ("fr", "en"...), or "". */
  language: string;
}

/** What Whisper's JSON file says: the lyrics one phrase per line, and the language. */
export function parseWhisperJson(raw: string): WhisperResult | null {
  try {
    const data = JSON.parse(raw) as { text?: unknown; language?: unknown; segments?: Array<{ text?: unknown }> };
    const lines = Array.isArray(data.segments)
      ? data.segments.map((s) => (typeof s?.text === 'string' ? s.text.trim() : '')).filter(Boolean)
      : [];
    const text = lines.length ? lines.join('\n') : typeof data.text === 'string' ? data.text.trim() : '';
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
      const proc = spawn(whisperCmd, args, { stdio: 'ignore' });
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
        else reject(new Error(`Whisper exited with code ${code}`));
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
