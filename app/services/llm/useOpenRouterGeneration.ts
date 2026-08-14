import { useReducer, useRef, useCallback } from 'react';
import { OpenRouterProvider } from './openrouter';
import {
  OpenRouterError,
  type GenStage,
  type SongDraft,
  type SongDraftInput,
  type FormatInput,
  type ErrorCode,
} from './types';

interface PendingUsage {
  promptTokens: number;
  completionTokens: number;
  costUsd: number | null;
}

interface State {
  state: GenStage;
  activeOp: 'generate' | 'format' | null;
  activePrimary: 'lyrics' | 'caption' | null;
  lastDraft: SongDraft | null;
  lastInput: { op: 'generate' | 'format'; input: SongDraftInput | FormatInput } | null;
  pendingUsage: PendingUsage | null;
}

type Action =
  | { type: 'start'; op: 'generate' | 'format'; primary: 'lyrics' | 'caption'; input: SongDraftInput | FormatInput }
  | { type: 'firstChunk' }
  | { type: 'chunk'; raw: string; partial: Partial<SongDraft>; openStringField?: { name: keyof SongDraft; valueSoFar: string } }
  | { type: 'parsing' }
  | { type: 'usage'; promptTokens: number; completionTokens: number; costUsd: number | null }
  | { type: 'success'; draft: SongDraft }
  | { type: 'cancelled' }
  | { type: 'error'; message: string; code: ErrorCode }
  | { type: 'dismiss' };

const initialState: State = {
  state: { kind: 'idle' },
  activeOp: null,
  activePrimary: null,
  lastDraft: null,
  lastInput: null,
  pendingUsage: null,
};

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'start':
      return {
        ...s,
        state: { kind: 'connecting', startedAt: Date.now() },
        activeOp: a.op,
        activePrimary: a.primary,
        lastInput: { op: a.op, input: a.input },
        pendingUsage: null,
      };
    case 'firstChunk':
      return {
        ...s,
        state: {
          kind: 'streaming',
          startedAt: ('startedAt' in s.state ? s.state.startedAt : Date.now()),
          bytesReceived: 0,
          rawPreview: '',
          partial: {},
        },
      };
    case 'chunk':
      return {
        ...s,
        state: {
          kind: 'streaming',
          startedAt: ('startedAt' in s.state ? s.state.startedAt : Date.now()),
          bytesReceived: a.raw.length,
          rawPreview: a.raw.slice(-2000),
          partial: a.partial,
        },
      };
    case 'usage':
      return {
        ...s,
        pendingUsage: {
          promptTokens: a.promptTokens,
          completionTokens: a.completionTokens,
          costUsd: a.costUsd,
        },
      };
    case 'parsing':
      return { ...s, state: { kind: 'parsing', startedAt: Date.now() } };
    case 'success': {
      const usage: PendingUsage = s.pendingUsage ?? { promptTokens: 0, completionTokens: 0, costUsd: null };
      return {
        ...s,
        state: { kind: 'success', draft: a.draft, usage, finishedAt: Date.now() },
        activeOp: null,
        activePrimary: null,
        lastDraft: a.draft,
        pendingUsage: null,
      };
    }
    case 'cancelled':
      return {
        ...s,
        state: { kind: 'cancelled', finishedAt: Date.now() },
        activeOp: null,
        activePrimary: null,
        pendingUsage: null,
      };
    case 'error':
      return {
        ...s,
        state: { kind: 'error', message: a.message, code: a.code, finishedAt: Date.now() },
        activeOp: null,
        activePrimary: null,
        pendingUsage: null,
      };
    case 'dismiss':
      return { ...s, state: { kind: 'idle' }, pendingUsage: null };
    default:
      return s;
  }
}

export interface UseOpenRouterGenerationOptions {
  onPartial?: (partial: Partial<SongDraft>, openStringField?: { name: keyof SongDraft; valueSoFar: string }) => void;
  onFinal?: (draft: SongDraft) => void;
}

function isBusy(kind: GenStage['kind']): boolean {
  return kind === 'connecting' || kind === 'streaming' || kind === 'parsing';
}

export function useOpenRouterGeneration(opts: UseOpenRouterGenerationOptions = {}) {
  const [s, dispatch] = useReducer(reducer, initialState);
  const ctrlRef = useRef<AbortController | null>(null);
  const providerRef = useRef<OpenRouterProvider | null>(null);
  if (providerRef.current === null) providerRef.current = new OpenRouterProvider();
  const { onPartial, onFinal } = opts;

  const cancel = useCallback(() => {
    ctrlRef.current?.abort();
  }, []);

  const dismissError = useCallback(() => {
    dispatch({ type: 'dismiss' });
  }, []);

  const run = useCallback(
    async (op: 'generate' | 'format', input: SongDraftInput | FormatInput) => {
      // Block re-entry while a run is in-flight
      if (isBusy(s.state.kind)) return;

      const ctrl = new AbortController();
      ctrlRef.current = ctrl;
      const primary = (input as SongDraftInput).primary;
      dispatch({ type: 'start', op, primary, input });

      try {
        const draft =
          op === 'generate'
            ? await providerRef.current!.generate(input as SongDraftInput, {
                signal: ctrl.signal,
                onEvent: (e) => {
                  if (e.type === 'firstChunk') {
                    dispatch({ type: 'firstChunk' });
                  } else if (e.type === 'chunk') {
                    dispatch({
                      type: 'chunk',
                      raw: e.raw,
                      partial: e.partial,
                      openStringField: e.openStringField,
                    });
                    onPartial?.(e.partial, e.openStringField);
                  } else if (e.type === 'usage') {
                    dispatch({
                      type: 'usage',
                      promptTokens: e.promptTokens,
                      completionTokens: e.completionTokens,
                      costUsd: e.costUsd,
                    });
                  }
                },
              })
            : await providerRef.current!.format(input as FormatInput, {
                signal: ctrl.signal,
                onEvent: (e) => {
                  if (e.type === 'firstChunk') {
                    dispatch({ type: 'firstChunk' });
                  } else if (e.type === 'chunk') {
                    dispatch({
                      type: 'chunk',
                      raw: e.raw,
                      partial: e.partial,
                      openStringField: e.openStringField,
                    });
                    onPartial?.(e.partial, e.openStringField);
                  } else if (e.type === 'usage') {
                    dispatch({
                      type: 'usage',
                      promptTokens: e.promptTokens,
                      completionTokens: e.completionTokens,
                      costUsd: e.costUsd,
                    });
                  }
                },
              });

        dispatch({ type: 'parsing' });
        dispatch({ type: 'success', draft });
        onFinal?.(draft);
      } catch (e: unknown) {
        const err = e as { name?: string; message?: string };
        if (ctrl.signal.aborted || err?.name === 'AbortError') {
          dispatch({ type: 'cancelled' });
        } else {
          const code: ErrorCode = e instanceof OpenRouterError ? e.code : 'UNKNOWN';
          dispatch({ type: 'error', message: String(err?.message ?? e), code });
        }
      }
    },
    [s.state.kind, onPartial, onFinal],
  );

  const runGenerate = useCallback((input: SongDraftInput) => run('generate', input), [run]);
  const runFormat = useCallback((input: FormatInput) => run('format', input), [run]);

  const retry = useCallback(() => {
    if (!s.lastInput) return;
    run(s.lastInput.op, s.lastInput.input);
  }, [s.lastInput, run]);

  return {
    state: s.state,
    activeOp: s.activeOp,
    activePrimary: s.activePrimary,
    lastDraft: s.lastDraft,
    runGenerate,
    runFormat,
    cancel,
    dismissError,
    retry,
  };
}
