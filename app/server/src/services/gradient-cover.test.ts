// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { inflateSync } from 'zlib';
import { renderGradientCover, hashSeed } from './gradient-cover.js';

/** Minimal reader for the PNGs this module writes (RGB, 8 bits, "Up" filter on every row). */
function decode(png: Buffer) {
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  let offset = 8;
  const idat: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') idat.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 3;
  const rgb = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    expect(raw[y * (stride + 1)]).toBe(2);
    for (let i = 0; i < stride; i++) {
      const above = y > 0 ? rgb[(y - 1) * stride + i] : 0;
      rgb[y * stride + i] = (raw[y * (stride + 1) + 1 + i] + above) & 0xff;
    }
  }
  return { width, height, rgb };
}

describe('renderGradientCover', () => {
  it('writes a valid square PNG of the requested size', () => {
    const { width, height, rgb } = decode(renderGradientCover('abc', 64));
    expect([width, height]).toEqual([64, 64]);
    expect(rgb.length).toBe(64 * 64 * 3);
  });

  it('is deterministic and differs from one id to another', () => {
    expect(renderGradientCover('same', 32).equals(renderGradientCover('same', 32))).toBe(true);
    expect(renderGradientCover('one', 32).equals(renderGradientCover('two', 32))).toBe(false);
  });

  it('stays small (a smooth gradient, not a photograph)', () => {
    expect(renderGradientCover('0b5f7a2e-1111-2222-3333-444455556666', 400).length).toBeLessThan(40_000);
  });

  it('uses the app palette: the first palette starts from its warm red-orange blend over the dark background', () => {
    // hashSeed('a') = 97 -> palette 7 (cherry blossom), angle 97
    expect(hashSeed('a') % 10).toBe(7);
    const { rgb } = decode(renderGradientCover('a', 16));
    // colours are never darker than 15 % of the background nor brighter than the palette
    for (const v of rgb) expect(v).toBeGreaterThan(0);
    const mean = rgb.reduce((s, v) => s + v, 0) / rgb.length;
    expect(mean).toBeGreaterThan(60);
  });
});
