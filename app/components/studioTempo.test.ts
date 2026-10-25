// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { applySongTempoToEditor } from './studioBridge';

function frameWith(clips: number, SetBeat: ReturnType<typeof vi.fn> | null = vi.fn()): HTMLIFrameElement {
  const multitrack = { ListClips: () => Array.from({ length: clips }, (_, i) => ({ id: `c${i}` })), ...(SetBeat ? { SetBeat } : {}) };
  return { contentWindow: { PKAudioEditor: { multitrack, fireEvent: vi.fn() } } } as unknown as HTMLIFrameElement;
}

describe('applySongTempoToEditor', () => {
  it('gives the empty editor the tempo and the signature of the song', () => {
    const set = vi.fn();
    expect(applySongTempoToEditor(frameWith(0, set), { bpm: 85, timeSignature: '3' })).toBe(true);
    expect(set).toHaveBeenCalledWith(85, '3/4');
  });
  it('understands the full form and 6/8', () => {
    const set = vi.fn();
    applySongTempoToEditor(frameWith(0, set), { bpm: 100, timeSignature: '4/4' });
    applySongTempoToEditor(frameWith(0, set), { bpm: 70, timeSignature: '6' });
    expect(set.mock.calls).toEqual([[100, '4/4'], [70, '6/8']]);
  });
  it('leaves alone what the song does not say or the grid does not have', () => {
    const set = vi.fn();
    applySongTempoToEditor(frameWith(0, set), { bpm: 90, timeSignature: '2' });   // 2/4: no such grid
    applySongTempoToEditor(frameWith(0, set), { bpm: 0, timeSignature: '3' });
    applySongTempoToEditor(frameWith(0, set), { timeSignature: 'N/A' } as never);
    expect(set.mock.calls).toEqual([[90, null], [null, '3/4']]);
  });
  it('does nothing when the song says neither', () => {
    const set = vi.fn();
    expect(applySongTempoToEditor(frameWith(0, set), { bpm: undefined, timeSignature: '' })).toBe(false);
    expect(set).not.toHaveBeenCalled();
  });
  it('does not change the pace once the editor holds something', () => {
    const set = vi.fn();
    expect(applySongTempoToEditor(frameWith(2, set), { bpm: 85, timeSignature: '4' })).toBe(false);
    expect(set).not.toHaveBeenCalled();
  });
  it('copes with an editor that is not ready or too old to know it', () => {
    expect(applySongTempoToEditor(null, { bpm: 85 })).toBe(false);
    expect(applySongTempoToEditor(frameWith(0, null), { bpm: 85 })).toBe(false);
  });
});
