// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { MODEL_INFO } from './modelNames';
import { VRAM_TOLERANCE_GB, formatGb, needsMoreVram, splitByVram, vramNeeded } from './modelFit';

const ids = (models: { id: string }[]) => models.map((m) => m.id);
const ALL = Object.keys(MODEL_INFO).map((id) => ({ id }));
const hiddenAt = (gb: number | null) => ids(splitByVram(ALL, gb, () => false).tooBig).sort();

describe('which models a card can run', () => {
  it('reads the minimum the engine announces, and nothing for a model it does not know', () => {
    expect(vramNeeded('acestep-v15-turbo')).toBe(6);
    expect(vramNeeded('acestep-v15-xl-turbo-bf16')).toBe(8);
    expect(vramNeeded('acestep-v15-xl-turbo')).toBe(12);
    for (const unknown of ['my-finetune', 'marcorez8/acestep-v15-xl-turbo-bf16', '', 'constructor', '__proto__', 'toString']) expect(vramNeeded(unknown), unknown).toBeNull();
  });

  it('every announced minimum is a positive number (a 0 would silently hide nothing, a NaN everything)', () => {
    for (const [id, info] of Object.entries(MODEL_INFO)) {
      expect(Number.isFinite(info.vramMin) && info.vramMin > 0, id).toBe(true);
    }
  });

  it('on an 8 GB card: the 2B models and the compact XL stay, the big XL go behind the link', () => {
    expect(hiddenAt(8)).toEqual(['acestep-v15-xl-base', 'acestep-v15-xl-merge-sft-turbo', 'acestep-v15-xl-sft', 'acestep-v15-xl-turbo']);
  });

  it('on a 6 GB card the compact XL goes too, on 12 GB nothing does', () => {
    expect(hiddenAt(6)).toEqual(['acestep-v15-xl-base', 'acestep-v15-xl-merge-sft-turbo', 'acestep-v15-xl-sft', 'acestep-v15-xl-turbo', 'acestep-v15-xl-turbo-bf16']);
    expect(hiddenAt(12)).toEqual([]);
    expect(hiddenAt(24)).toEqual([]);
  });

  it('a card reports a little under its label: "8 GB" shown as 7.6 keeps the models made for 8', () => {
    expect(VRAM_TOLERANCE_GB).toBe(0.5);
    expect(needsMoreVram('acestep-v15-xl-turbo-bf16', 7.6)).toBe(false);
    expect(needsMoreVram('acestep-v15-xl-turbo-bf16', 7.96)).toBe(false);
    expect(needsMoreVram('acestep-v15-turbo', 5.8)).toBe(false); // a "6 GB" card
    expect(needsMoreVram('acestep-v15-xl-turbo', 11.6)).toBe(false); // a "12 GB" card
  });

  it('the margin is exact: 7.5 keeps an 8 GB model, 7.49 does not', () => {
    expect(needsMoreVram('acestep-v15-xl-turbo-bf16', 7.5)).toBe(false);
    expect(needsMoreVram('acestep-v15-xl-turbo-bf16', 7.49)).toBe(true);
    expect(needsMoreVram('acestep-v15-xl-turbo', 11.5)).toBe(false);
    expect(needsMoreVram('acestep-v15-xl-turbo', 11.49)).toBe(true);
  });

  it('hides nothing when the memory is unknown: no NVIDIA card, engine not started, failed request', () => {
    for (const unknown of [null, undefined, 0, -1, NaN, Infinity, -Infinity]) {
      expect(hiddenAt(unknown as number | null), String(unknown)).toEqual([]);
    }
  });

  it('never claims anything about a model it knows nothing about', () => {
    for (const custom of ['my-finetune', 'marcorez8/acestep-v15-xl-turbo-bf16', 'constructor', '__proto__']) expect(needsMoreVram(custom, 2), custom).toBe(false);
  });

  it('keeps what must stay listed (chosen, loaded, on the disk), and the order', () => {
    const { fitting, tooBig } = splitByVram(ALL, 8, (id) => id === 'acestep-v15-xl-turbo');
    expect(ids(tooBig).sort()).toEqual(['acestep-v15-xl-base', 'acestep-v15-xl-merge-sft-turbo', 'acestep-v15-xl-sft']);
    expect(ids(fitting)).toEqual(ids(ALL).filter((id) => !ids(tooBig).includes(id)));
  });

  it('writes memory without a useless decimal', () => {
    expect(formatGb(8)).toBe('8');
    expect(formatGb(7.96)).toBe('8');
    expect(formatGb(7.6)).toBe('7.6');
    expect(formatGb(11.99)).toBe('12');
    expect(formatGb(24)).toBe('24');
    expect(formatGb(5.84)).toBe('5.8');
  });
});
