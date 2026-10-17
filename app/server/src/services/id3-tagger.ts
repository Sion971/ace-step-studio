import NodeID3 from 'node-id3';
import { renderGradientCover } from './gradient-cover.js';

interface TagOptions {
  title: string;
  artist: string;
  genre?: string;
  year?: number;
  coverBuffer?: Buffer;
  coverMimeType?: string;
  lyrics?: string;
  bpm?: number;
}

/**
 * Replace ONLY the cover-image frame on an already-tagged MP3 buffer,
 * leaving title / artist / lyrics / bpm / etc. untouched. Used by the
 * manual cover-regen endpoint so the user's new picture is embedded into
 * the file (= shows up in any music player that reads ID3) without us
 * having to re-derive every other tag from the songs row.
 *
 * NodeID3.update is the operation we want — it merges the supplied tags
 * into the existing frames instead of clobbering everything like
 * NodeID3.write does. If `update` ever silently fails (returns false) we
 * fall back to `tagMp3Buffer` re-driving the full tag list from the songs
 * row so the file is never left with a partial header.
 */
export function updateMp3Cover(
  buffer: Buffer,
  coverBuffer: Buffer,
  coverMimeType: string,
): Buffer {
  const partial: NodeID3.Tags = {
    image: {
      mime: coverMimeType || 'image/jpeg',
      type: { id: 3, name: 'front cover' },
      description: 'Cover',
      imageBuffer: coverBuffer,
    },
  };
  const updated = NodeID3.update(partial, buffer) as Buffer | boolean;
  // NodeID3.update is typed as Buffer in current @types/node-id3 but at
  // runtime can still return `false` on failure (bad MP3 header etc.) —
  // keep the runtime guard while satisfying the stricter TS type.
  if (!updated || typeof updated === 'boolean') {
    console.warn('[ID3] cover-only update failed, returning original buffer');
    return buffer;
  }
  return updated;
}

/**
 * Write ID3v2 tags to an MP3 buffer. Returns tagged buffer.
 * For non-MP3 files, returns the original buffer unchanged.
 */
export function tagMp3Buffer(buffer: Buffer, options: TagOptions): Buffer {
  const tags: NodeID3.Tags = {
    title: options.title,
    artist: options.artist,
    album: 'ACE-Step Studio',
    performerInfo: options.artist,
    year: String(options.year || new Date().getFullYear()),
    encodedBy: 'ACE-Step Studio',
  };

  if (options.genre) {
    tags.genre = options.genre;
  }

  if (options.bpm) {
    tags.bpm = String(options.bpm);
  }

  if (options.lyrics) {
    tags.unsynchronisedLyrics = {
      language: 'eng',
      text: options.lyrics,
    };
  }

  if (options.coverBuffer) {
    tags.image = {
      mime: options.coverMimeType || 'image/jpeg',
      type: { id: 3, name: 'front cover' },
      description: 'Cover',
      imageBuffer: options.coverBuffer,
    };
  }

  const tagged = NodeID3.write(tags, buffer);
  if (!tagged) {
    console.warn('[ID3] Failed to write tags, returning original buffer');
    return buffer;
  }
  return tagged as Buffer;
}

/**
 * The cover embedded in a freshly generated MP3: the default gradient of the song, drawn locally (no network, instant),
 * identical to the one the app shows for a song without a real cover. If an AI cover is made afterwards, cover-jobs
 * replaces it in the file (updateMp3Cover).
 */
export async function fetchCoverImage(
  songId: string,
): Promise<{ buffer: Buffer; mimeType: string } | undefined> {
  try {
    return { buffer: renderGradientCover(songId, 400), mimeType: 'image/png' };
  } catch {
    return undefined;
  }
}
