import { deflateSync } from 'zlib';

/**
 * The default cover, as a PNG: the SAME image as `getCoverUrl` in app/services/api.ts (same ten palettes, same hash, same
 * rotated linear gradient at 85 % over the dark background), so that the thumbnail embedded in a downloaded MP3 looks like
 * the one shown in the app. Pure Node (zlib), no network, no image library: it replaces the picsum.photos fetch.
 *
 * Keep COVER_PALETTES and hashSeed in step with api.ts if either changes.
 */
const COVER_PALETTES: ReadonlyArray<readonly [string, string, string]> = [
  ['#FF6B6B', '#FEC89A', '#1a1a2e'],
  ['#0077B6', '#00B4D8', '#03045E'],
  ['#2D6A4F', '#40916C', '#1B4332'],
  ['#F72585', '#7209B7', '#10002B'],
  ['#FF9500', '#FF5400', '#2D1B00'],
  ['#48CAE4', '#00F5D4', '#0A0A1A'],
  ['#E0AAFF', '#C77DFF', '#240046'],
  ['#FFCCD5', '#FF758F', '#2B0A14'],
  ['#00FF87', '#FF00E5', '#0D0D0D'],
  ['#7400B8', '#4EA8DE', '#03071E'],
];

export function hashSeed(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  return Math.abs(hash) || 1;
}

const hexToRgb = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Encodes raw RGB rows as a PNG. Every row uses the "Up" filter: on a smooth gradient the deltas are tiny and deflate well. */
export function encodePng(rgb: Buffer, width: number, height: number): Buffer {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 2;
    for (let i = 0; i < stride; i++) {
      const above = y > 0 ? rgb[(y - 1) * stride + i] : 0;
      raw[rowStart + 1 + i] = (rgb[y * stride + i] - above) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The default cover of a song (or playlist) id, `size` x `size` pixels. */
export function renderGradientCover(id: string, size = 400): Buffer {
  const hash = hashSeed(id);
  const [c1, c2, bg] = COVER_PALETTES[hash % COVER_PALETTES.length].map(hexToRgb);
  const angle = ((hash % 360) * Math.PI) / 180;

  // SVG: gradient from (0,0) to (1,1) of the box, rotated by `angle` around its centre.
  const rotate = (x: number, y: number): [number, number] => {
    const dx = x - 0.5;
    const dy = y - 0.5;
    return [0.5 + dx * Math.cos(angle) - dy * Math.sin(angle), 0.5 + dx * Math.sin(angle) + dy * Math.cos(angle)];
  };
  const [x0, y0] = rotate(0, 0);
  const [x1, y1] = rotate(1, 1);
  const vx = x1 - x0;
  const vy = y1 - y0;
  const len2 = vx * vx + vy * vy;

  const rgb = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = (x + 0.5) / size;
      const py = (y + 0.5) / size;
      const t = Math.min(1, Math.max(0, ((px - x0) * vx + (py - y0) * vy) / len2));
      const o = (y * size + x) * 3;
      for (let k = 0; k < 3; k++) {
        const g = c1[k] + (c2[k] - c1[k]) * t;
        rgb[o + k] = Math.round(g * 0.85 + bg[k] * 0.15);
      }
    }
  }
  return encodePng(rgb, size, size);
}
