/**
 * Orders the hand-offs of successive Create clicks.
 *
 * Each click writes its draft (local LM), then hands its generation to the
 * server, which registers the job a moment later. The next click used to ask
 * "is a job running?" in that gap, found none, and started ITS draft while the
 * first generation was still being submitted: two drafts back to back, then a
 * generation that sat behind the second draft in the engine (the LM blocks it).
 * Cancelling at that moment reached a busy engine and did nothing.
 *
 * `enter()` is called synchronously at click time. It returns the previous
 * click's hand-off (`previous`: to await before starting a draft) and a `done`
 * function the click MUST call on every exit path, success or not.
 */
export function createHandoffBarrier() {
  let tail: Promise<void> = Promise.resolve();
  return {
    enter(): { previous: Promise<void>; done: () => void } {
      const previous = tail;
      let done: () => void = () => {};
      tail = new Promise<void>((resolve) => { done = resolve; });
      return { previous, done };
    },
  };
}
