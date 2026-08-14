export interface LrcLine {
  time: number; // seconds
  text: string;
  isSection: boolean; // [Verse], [Chorus], etc.
}

/**
 * Parse LRC formatted text into timed lines.
 * Format: [mm:ss.xx] text
 */
export function parseLrc(lrcContent: string): LrcLine[] {
  if (!lrcContent) return [];

  const lines: LrcLine[] = [];
  const regex = /\[(\d{2}):(\d{2})\.(\d{2})\](.*)/;

  for (const raw of lrcContent.split('\n')) {
    const match = raw.match(regex);
    if (!match) continue;

    const minutes = parseInt(match[1], 10);
    const seconds = parseInt(match[2], 10);
    const centiseconds = parseInt(match[3], 10);
    const text = match[4].trim();

    if (!text) continue;

    const time = minutes * 60 + seconds + centiseconds / 100;
    const isSection = /^\[.*\]$/.test(text);

    lines.push({ time, text, isSection });
  }

  return lines.sort((a, b) => a.time - b.time);
}

/**
 * Find the current lyric line based on playback time.
 * Returns index of current line, or -1 if before first line.
 */
export function getCurrentLrcIndex(lines: LrcLine[], currentTime: number): number {
  if (lines.length === 0) return -1;

  for (let i = lines.length - 1; i >= 0; i--) {
    if (currentTime >= lines[i].time) return i;
  }

  return -1;
}
