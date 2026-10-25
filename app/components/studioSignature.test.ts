// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { editorSignature, hasUnsavedWork, pauseEditor } from './studioBridge';

type State = { tracks: object[]; clips: object[]; master_vol?: number };
const frame = (mt: Record<string, unknown>) => ({ contentWindow: { PKAudioEditor: { multitrack: mt, fireEvent: vi.fn() } } }) as unknown as HTMLIFrameElement;
const sharedBuffer = { big: true };
const state = (over: Partial<{ vol: number; start: number; name: string }> = {}): State => ({
  tracks: [{ id: 'mt1', name: over.name ?? 'Batterie', vol: over.vol ?? 1, pan: 0 }],
  clips: [{ id: 'mc1', track: 'mt1', start: over.start ?? 0, in: 0, out: 2, name: 'a.wav', buffer: sharedBuffer }],
  master_vol: 1,
});

describe('editorSignature / hasUnsavedWork', () => {
  it('is empty while there is nothing on the timeline, so there is nothing to lose', () => {
    expect(editorSignature(frame({ getState: () => ({ tracks: [{ id: 'mt1' }], clips: [] }) }))).toBe('');
    expect(editorSignature(frame({}))).toBe('');
    expect(editorSignature(null)).toBe('');
    expect(hasUnsavedWork(frame({ getState: () => state() }), '')).toBe(true);
    expect(hasUnsavedWork(frame({ getState: () => ({ tracks: [], clips: [] }) }), '')).toBe(false);
  });
  it('does not change while the work does not, and changes with a volume, a position or a name', () => {
    const base = editorSignature(frame({ getState: () => state() }));
    expect(base).not.toBe('');
    expect(editorSignature(frame({ getState: () => state() }))).toBe(base);
    for (const over of [{ vol: 0.5 }, { start: 3 }, { name: 'Basse' }]) {
      expect(editorSignature(frame({ getState: () => state(over) })), JSON.stringify(over)).not.toBe(base);
    }
    expect(hasUnsavedWork(frame({ getState: () => state() }), base)).toBe(false);
    expect(hasUnsavedWork(frame({ getState: () => state({ vol: 0.5 }) }), base)).toBe(true);
  });
  it('does not put the audio in the signature', () => {
    expect(editorSignature(frame({ getState: () => state() }))).not.toContain('big');
  });
  it('copes with an editor that throws', () => {
    expect(editorSignature(frame({ getState: () => { throw new Error('x'); } }))).toBe('');
  });
});

describe('pauseEditor', () => {
  it('pauses only when the editor is playing', () => {
    const pause = vi.fn();
    pauseEditor(frame({ IsPlaying: () => false, Pause: pause }));
    expect(pause).not.toHaveBeenCalled();
    pauseEditor(frame({ IsPlaying: () => true, Pause: pause }));
    expect(pause).toHaveBeenCalledTimes(1);
    expect(() => pauseEditor(null)).not.toThrow();
  });
});

describe('editorSignature and replaced audio', () => {
  it('changes when an effect or a cut gives a clip another buffer, and not otherwise', () => {
    const buf1 = {}; const buf2 = {};
    const st = (buffer: object) => ({ tracks: [{ id: 'mt1', name: 'A', vol: 1, pan: 0 }], clips: [{ id: 'mc1', track: 'mt1', start: 0, in: 0, out: 2, name: 'a.wav', buffer }], master_vol: 1 });
    const a = editorSignature(frame({ getState: () => st(buf1) }));
    expect(editorSignature(frame({ getState: () => st(buf1) }))).toBe(a);
    expect(editorSignature(frame({ getState: () => st(buf2) }))).not.toBe(a);
  });
});
