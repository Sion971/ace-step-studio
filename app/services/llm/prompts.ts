import systemGenerateEn from './prompts/system_generate.en.md?raw';
import systemFormatEn from './prompts/system_format.en.md?raw';
import type { SongDraftInput, FormatInput } from './types';

export const DEFAULT_GENERATE_PROMPT: string = systemGenerateEn;
export const DEFAULT_FORMAT_PROMPT: string = systemFormatEn;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

function resolveSystem(override: string | undefined, fallback: string): string {
  if (override && override.trim().length > 0) return override;
  return fallback;
}

export function buildGenerate(input: SongDraftInput, systemOverride?: string): ChatMessage[] {
  const userLines = [
    `topic: ${input.topic}`,
    `primary: ${input.primary}`,
    `language: ${input.language}`,
    `instrumental: ${input.instrumental}`,
  ];
  if (input.durationSec !== undefined && input.durationSec !== null) {
    userLines.push(`durationSec hint: ${input.durationSec}`);
  }
  return [
    { role: 'system', content: resolveSystem(systemOverride, DEFAULT_GENERATE_PROMPT) },
    { role: 'user', content: userLines.join('\n') },
  ];
}

export function buildFormat(input: FormatInput, systemOverride?: string): ChatMessage[] {
  // Strip undefined fields so the JSON is clean
  const compact: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v !== undefined) compact[k] = v;
  }
  return [
    { role: 'system', content: resolveSystem(systemOverride, DEFAULT_FORMAT_PROMPT) },
    { role: 'user', content: JSON.stringify(compact, null, 2) },
  ];
}
