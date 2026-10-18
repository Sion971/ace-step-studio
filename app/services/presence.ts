// services/presence.ts
//
// Tells the server "a Studio page is open", by holding one Server-Sent Events connection to /api/presence for as long as the
// page lives. When the last page is closed the server (started with run.sh --quit-on-close, which the desktop launcher does)
// stops itself and the engine; see server/src/services/presence.ts. The browser reconnects by itself after a network blip.

export function startPresence(): EventSource | null {
  if (typeof EventSource === 'undefined') return null;
  try {
    return new EventSource('/api/presence');
  } catch {
    return null; // a missing server-side stop is never worth a broken page
  }
}
