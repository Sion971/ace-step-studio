// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { addTrackToEditor } from './studioBridge';

function frameWith(fireEvent: (...a: unknown[]) => void): HTMLIFrameElement {
  return { contentWindow: { PKAudioEditor: { multitrack: {}, fireEvent } } } as unknown as HTMLIFrameElement;
}
const file = new File(['x'], 'a.wav');

describe('addTrackToEditor and the name of the channel', () => {
  it('passes the name along with the start when there is one', () => {
    const fire = vi.fn();
    expect(addTrackToEditor(frameWith(fire), file, 2.5, '  Batterie ')).toBe(true);
    expect(fire).toHaveBeenCalledWith('RequestAddTrackFile', file, { start: 2.5, name: 'Batterie' });
  });

  it('keeps the plain start (the editor numbers the channel itself) when there is no name, or an empty one', () => {
    const fire = vi.fn();
    addTrackToEditor(frameWith(fire), file);
    addTrackToEditor(frameWith(fire), file, 1, '   ');
    expect(fire.mock.calls).toEqual([['RequestAddTrackFile', file, 0], ['RequestAddTrackFile', file, 1]]);
  });

  it('says so when the editor is not there', () => {
    expect(addTrackToEditor(null, file, 0, 'Basse')).toBe(false);
  });
});
