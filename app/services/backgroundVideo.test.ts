import { describe, it, expect, vi, afterEach } from 'vitest';
import { openBackgroundVideo } from './backgroundVideo';

const created: HTMLVideoElement[] = [];
const realCreate = document.createElement.bind(document);

function track() {
  created.length = 0;
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string, opts?: ElementCreationOptions) => {
    const el = realCreate(tag, opts);
    if (tag === 'video') created.push(el as HTMLVideoElement);
    return el;
  }) as typeof document.createElement);
}

afterEach(() => vi.restoreAllMocks());

describe('openBackgroundVideo', () => {
  it('reports the first decoded frame', () => {
    track();
    const onReady = vi.fn();
    openBackgroundVideo('blob:http://localhost/abc', { onReady, onError: vi.fn() });
    created[0].dispatchEvent(new Event('loadeddata'));
    expect(onReady).toHaveBeenCalledWith(created[0]);
  });

  it('reports a source the browser cannot load', () => {
    track();
    const onError = vi.fn();
    openBackgroundVideo('blob:http://localhost/abc', { onReady: vi.fn(), onError });
    created[0].dispatchEvent(new Event('error'));
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('stays silent after it was released: the "empty src" error fired by the browser is not a failure', () => {
    track();
    const onError = vi.fn();
    const onReady = vi.fn();
    const dispose = openBackgroundVideo('blob:http://localhost/abc', { onReady, onError });
    dispose();
    // What browsers do right after `src` is emptied.
    created[0].dispatchEvent(new Event('error'));
    created[0].dispatchEvent(new Event('loadeddata'));
    expect(onError).not.toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalled();
    expect(created[0].hasAttribute('src')).toBe(false);
  });

  it('can be released twice', () => {
    track();
    const dispose = openBackgroundVideo('blob:http://localhost/abc', { onReady: vi.fn(), onError: vi.fn() });
    dispose();
    expect(() => dispose()).not.toThrow();
  });

  it('only sets crossOrigin for a remote source', () => {
    track();
    openBackgroundVideo('blob:http://localhost/abc', { onReady: vi.fn(), onError: vi.fn() });
    openBackgroundVideo('data:video/mp4;base64,AAAA', { onReady: vi.fn(), onError: vi.fn() });
    openBackgroundVideo('https://videos.example/clip.mp4', { onReady: vi.fn(), onError: vi.fn() });
    expect(created[0].crossOrigin).toBeFalsy();
    expect(created[1].crossOrigin).toBeFalsy();
    expect(created[2].crossOrigin).toBe('anonymous');
  });
});
