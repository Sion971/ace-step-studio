// Domain types

export interface SongDraftInput {
  topic: string;
  primary: 'lyrics' | 'caption';
  language: string;        // 'en', 'ru', 'zh', 'ja', 'ko', etc. — same values as today's vocalLanguage
  instrumental: boolean;
  durationSec?: number;    // user hint
  /**
   * If true, hint the OpenRouter model to use reasoning / extended thinking.
   * Forwarded as `reasoning: { effort: 'medium' }` in the request body — honored
   * by reasoning-capable models (Claude w/ extended thinking, GPT-5, DeepSeek-R1)
   * and silently ignored by others.
   */
  thinking?: boolean;
}

export interface FormatInput {
  caption: string;
  lyrics: string;
  bpm?: number;
  durationSec?: number;
  keyScale?: string;
  timeSignature?: string;
  language: string;
  instrumental: boolean;
  primary: 'lyrics' | 'caption';
  /** See SongDraftInput.thinking. */
  thinking?: boolean;
}

export interface SongDraft {
  title: string;
  caption: string;
  lyrics: string;
  tags: string[];
  bpm: number;
  keyScale: string;
  timeSignature: string;
  durationSec: number;
  /**
   * One-or-two-sentence English visual description of an album cover for THIS
   * specific song. The LLM tailors it to the lyrics and mood. Used as the core
   * Pollinations prompt — backend wraps it with "square music album cover
   * artwork, … , no text" framing. Empty string is a valid value (the
   * Pollinations layer falls back to a keyword-based default when it's empty).
   */
  coverPrompt: string;
}

// Provider config (persisted in localStorage)

export interface OpenRouterConfig {
  apiKey: string;
  model: string;
  temperature: number;
  topP: number;
  topK: number;
  minP: number;
  frequencyPenalty: number;
  presencePenalty: number;
  repetitionPenalty: number;
  maxTokens: number;
  seed: number | null;
  systemPromptGenerate: string;  // empty = use built-in default from system_generate.en.md
  systemPromptFormat: string;    // empty = use built-in default from system_format.en.md
}

// Errors

export type ErrorCode =
  | 'KEY_MISSING'
  | 'KEY_INVALID'
  | 'RATE_LIMITED'
  | 'INSUFFICIENT_FUNDS'
  | 'MODEL_UNAVAILABLE'
  | 'SCHEMA_UNSUPPORTED'
  | 'SCHEMA_NONCOMPLIANT'
  | 'INVALID_JSON'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'UNKNOWN';

export class OpenRouterError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'OpenRouterError';
  }
}

// Generation state machine

export type GenStage =
  | { kind: 'idle' }
  | { kind: 'connecting'; startedAt: number }
  | {
      kind: 'streaming';
      startedAt: number;
      bytesReceived: number;
      rawPreview: string;
      partial: Partial<SongDraft>;
    }
  | { kind: 'parsing'; startedAt: number }
  | {
      kind: 'success';
      draft: SongDraft;
      usage: {
        promptTokens: number;
        completionTokens: number;
        costUsd: number | null;
      };
      finishedAt: number;
    }
  | { kind: 'cancelled'; finishedAt: number }
  | {
      kind: 'error';
      message: string;
      code: ErrorCode;
      finishedAt: number;
    };

// Provider streaming events

export type GenEvent =
  | { type: 'firstChunk' }
  | {
      type: 'chunk';
      raw: string;
      partial: Partial<SongDraft>;
      openStringField?: { name: keyof SongDraft; valueSoFar: string };
    }
  | { type: 'streamDone'; raw: string }
  | {
      type: 'usage';
      promptTokens: number;
      completionTokens: number;
      costUsd: number | null;
    };
