/**
 * Generations the user has asked for and that are not finished: the ones the
 * server already knows (running or queued) PLUS the clicks still waiting for
 * their turn (the lyrics/style draft of the previous click must finish first).
 * Both the Create button (n/10) and "Cancel all (n)" must show this same
 * number: the cancel button used to show only the server's jobs, so after 9
 * clicks it said 2 while 9 cards were waiting.
 */
export function totalGenerationSlots(activeJobCount: number, pendingClickCount: number): number {
  return Math.max(0, activeJobCount) + Math.max(0, pendingClickCount);
}
