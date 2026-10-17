/**
 * Loads the background video of the Video Studio preview into a detached <video> element.
 *
 * Why this is not inlined in the component: releasing a <video> by setting `src = ''` makes the browser fire an `error`
 * event (MEDIA_ERR_SRC_NOT_SUPPORTED, "empty src") on that element, a moment later. With the handlers still attached,
 * replacing or leaving the video made the PREVIOUS element report a failure — the screen showed "Video loaded" and the
 * preview played, yet the warning "the background video could not be loaded" was displayed (and the preview's current
 * video reference was cleared). The handlers are detached first and a disposed element reports nothing.
 */
export interface BackgroundVideoCallbacks {
  /** First frame decoded: the element can be drawn. */
  onReady: (video: HTMLVideoElement) => void;
  /** The browser could not load this source (unsupported codec, CORS on a remote source, ...). */
  onError: (video: HTMLVideoElement) => void;
}

/** Starts loading `url`; the returned function releases the element and silences it for good. */
export function openBackgroundVideo(url: string, callbacks: BackgroundVideoCallbacks): () => void {
  let disposed = false;
  const video = document.createElement('video');
  // `crossOrigin` only makes sense for a remote source; on a `blob:` URL (imported file) it is at best useless.
  if (!url.startsWith('blob:') && !url.startsWith('data:')) video.crossOrigin = 'anonymous';
  video.src = url;
  video.loop = true;
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  video.onloadeddata = () => {
    if (!disposed) callbacks.onReady(video);
  };
  video.onerror = () => {
    if (!disposed) callbacks.onError(video);
  };
  return () => {
    if (disposed) return;
    disposed = true;
    video.onloadeddata = null;
    video.onerror = null;
    video.pause();
    video.removeAttribute('src');
    try {
      video.load();
    } catch {
      /* not supported by every test environment */
    }
  };
}
