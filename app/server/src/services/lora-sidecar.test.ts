// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { boundedInteger, boundedNumber, modelLabel, normalizeSha, plain, plainList } from './lora-text.js';
import { KNOWN_SCHEMA_VERSION, parseSidecar, pickSidecar } from './lora-sidecar.js';
import { exampleSidecar } from './lora-sidecar.fixtures.js';

const SHA = 'ab'.repeat(32);
const parse = (value: unknown) => parseSidecar(JSON.stringify(value));

describe('lora-text', () => {
  it('keeps short plain strings from what an author writes', () => {
    expect(plain('  a   b\n c ', 20)).toBe('a b c');
    expect(plain('<script>alert(1)</script>', 50)).not.toMatch(/[<>]/);
    expect(plain('x'.repeat(500), 40)).toHaveLength(40);
    for (const notText of [undefined, null, 5, {}, ['a'], '', '   ', '\u0007\u0000']) expect(plain(notText, 20)).toBeNull();
    expect(plainList(['a', 5, null, 'b', 'c'], 2, 10)).toEqual(['a', 'b']);
    expect(plainList('single', 3, 10)).toEqual(['single']);
    expect(plainList({ a: 1 }, 3, 10)).toEqual([]);
  });

  it('bounds numbers, and a string is not a number', () => {
    expect(boundedNumber(0.5, 0, 4)).toBe(0.5);
    for (const bad of ['0.5', NaN, Infinity, -1, 5, null, undefined, {}, [1]]) expect(boundedNumber(bad, 0, 4)).toBeNull();
    expect(boundedInteger(8, 1, 200)).toBe(8);
    for (const bad of [8.5, 0, 201, '8', null]) expect(boundedInteger(bad, 1, 200)).toBeNull();
  });

  it('normalizes a checksum: case, "sha256:" prefix, and nothing else', () => {
    expect(normalizeSha(`sha256:${SHA.toUpperCase()}`)).toBe(SHA);
    for (const bad of [SHA.slice(1), `${SHA}0`, 'zz'.repeat(32), '', null, 5]) expect(normalizeSha(bad)).toBeNull();
  });

  it('keeps a Hub id, and keeps only the last segment of a folder on the author\'s machine', () => {
    expect(modelLabel('ACE-Step/Ace-Step1.5')).toBe('ACE-Step/Ace-Step1.5');
    expect(modelLabel('AceStep v1.5 Turbo (2B)')).toBe('AceStep v1.5 Turbo (2B)');
    expect(modelLabel('/root/checkpoints/acestep-v15-turbo')).toBe('acestep-v15-turbo');
    expect(modelLabel('~/models/acestep-v15-base/')).toBe('acestep-v15-base');
    expect(modelLabel('./local/x')).toBe('x');
    expect(modelLabel('../x')).toBe('x');
    expect(modelLabel('C:\\models\\acestep-xl')).toBe('acestep-xl');
    expect(modelLabel('/')).toBeNull();
    expect(modelLabel(null)).toBeNull();
    expect(modelLabel(42)).toBeNull();
  });
});

describe('parseSidecar', () => {
  it('reads a metadata file with the structure of a real one', () => {
    const parsed = parse(exampleSidecar(SHA));
    expect(parsed?.warnings).toEqual([]);
    expect(parsed?.info).toEqual({
      schemaVersion: 1,
      name: 'Example Lo-Fi',
      version: '1.0',
      author: 'Example Author',
      description: 'Example style. Covers: a mellow beat, vinyl crackle, jazzy chords; and a second, slower prompt.',
      baseModel: 'AceStep v1.5 Turbo',
      baseModelScale: '2B',
      baseModelRequired: 'AceStep v1.5 Turbo (2B)',
      genre: 'lo-fi',
      tags: ['mellow beat', 'vinyl crackle', 'jazzy chords'],
      triggerWord: 'ex-l0f1',
      triggerWords: [],
      recommended: { scale: 1, steps: 8, guidance: 7, shift: 3, sampleRate: 48000 },
      testedScale: [0.3, 1],
      examplePrompts: [
        { caption: 'mellow beat, vinyl crackle, jazzy chords', bpm: 80, key: 'F minor' },
        { caption: 'slow chords, soft drums, ambient textures', bpm: 70, key: 'A minor' },
      ],
      license: null,
      sourceUrl: null,
      weightsFile: 'adapter_model.safetensors',
      sha256: SHA,
      sizeBytes: 50000,
    });
  });

  it('is not an error when the file says little: what is missing is null', () => {
    const parsed = parse({});
    expect(parsed?.warnings).toEqual([]);
    expect(parsed?.info).toMatchObject({
      schemaVersion: null, name: null, baseModelRequired: null, triggerWord: null, triggerWords: [], testedScale: null, examplePrompts: [], license: null, sha256: null,
      recommended: { scale: null, steps: null, guidance: null, shift: null, sampleRate: null },
    });
  });

  it('answers null when the text is not a JSON object at all', () => {
    for (const text of ['', 'not json', '[1,2]', '"text"', '42', 'null', '{"a":']) expect(parseSidecar(text), JSON.stringify(text)).toBeNull();
  });

  it('survives sections of the wrong shape', () => {
    for (const section of ['model', 'classification', 'inference', 'compatibility', 'files', 'distribution']) {
      for (const wrong of [null, 'text', 42, [1, 2], true]) {
        const parsed = parse({ [section]: wrong });
        expect(parsed, `${section}=${JSON.stringify(wrong)}`).not.toBeNull();
        expect(parsed?.info.triggerWord ?? null).toBeNull();
      }
    }
  });

  it('uses the first of trigger_words when there is no primary one', () => {
    expect(parse({ inference: { trigger_words: ['one', 'two'] } })?.info).toMatchObject({ triggerWord: 'one', triggerWords: ['one', 'two'] });
    expect(parse({ inference: { primary_trigger_word: 'main', trigger_words: ['one'] } })?.info.triggerWord).toBe('main');
  });

  it('refuses numbers that cannot be right, instead of passing them on to the generation', () => {
    const { info } = parse({
      inference: { recommended_strength: 99, recommended_steps: 1e9, recommended_guidance: -5, recommended_shift: '3', sample_rate: 12.5, tested_strength_range: [1, 0.3] },
    })!;
    expect(info.recommended).toEqual({ scale: null, steps: null, guidance: null, shift: null, sampleRate: null });
    expect(info.testedScale).toBeNull();
    expect(parse({ inference: { tested_strength_range: [0.3] } })?.info.testedScale).toBeNull();
    expect(parse({ inference: { tested_strength_range: 'a-b' } })?.info.testedScale).toBeNull();
    expect(parse({ inference: { tested_strength_range: [0.5, 'x'] } })?.info.testedScale).toBeNull();
  });

  it('treats the text as untrusted', () => {
    const { info } = parse({
      name: '<img src=x onerror=alert(1)>',
      description: `Nice\u0007 style ${'blah '.repeat(500)}`,
      author: 'a'.repeat(300),
      inference: { primary_trigger_word: 'trig\ngger\u0000', example_prompts: [{ caption: '<b>x</b>', bpm: 9999, key: 'k'.repeat(99) }, { caption: 5 }, null, 'str'] },
      classification: { tags: ['ok', 3, '<x>', ...Array.from({ length: 60 }, (_, i) => `t${i}`)] },
    })!;
    expect(info.name).not.toMatch(/[<>]/);
    expect(info.description!.length).toBeLessThanOrEqual(600);
    expect(info.description).not.toMatch(/\u0007/);
    expect(info.author).toHaveLength(80);
    expect(info.triggerWord).toBe('trig gger');
    expect(info.examplePrompts).toEqual([{ caption: 'b x /b', bpm: null, key: 'k'.repeat(20) }]);
    expect(info.tags.length).toBeLessThanOrEqual(20);
    expect(info.tags.every((t) => !/[<>]/.test(t))).toBe(true);
  });

  it('keeps a link only if it is a short http(s) link', () => {
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'ftp://x/y', 'not a url', '', `https://x.example/${'a'.repeat(400)}`, 5, 'https://x.example/with space', 'https://x.example/"onclick', 'https://x.example/a\nb']) {
      expect(parse({ distribution: { source_url: bad } })?.info.sourceUrl, String(bad).slice(0, 30)).toBeNull();
    }
    expect(parse({ distribution: { source_url: 'https://example.com/lora' } })?.info.sourceUrl).toBe('https://example.com/lora');
    expect(parse({ distribution: { source_url: `https://example.com/${'a'.repeat(250)}` } })?.info.sourceUrl).toHaveLength(270); // long but whole: kept
    expect(parse({ distribution: { source_url: `https://example.com/${'a'.repeat(300)}` } })?.info.sourceUrl).toBeNull(); // too long: refused, never cut
  });

  it('warns about a newer format than it knows, and says so without refusing', () => {
    const newer = parse({ schema_version: KNOWN_SCHEMA_VERSION + 1, name: 'x' });
    expect(newer?.warnings.join(' ')).toMatch(/newer format/);
    expect(newer?.info.name).toBe('x');
    expect(parse({ schema_version: KNOWN_SCHEMA_VERSION })?.warnings).toEqual([]);
    expect(parse({ schema_version: '1' })?.info.schemaVersion).toBeNull();
  });

  it('reads the license when the author gives one', () => {
    expect(parse({ distribution: { license: 'cc-by-4.0' } })?.info.license).toBe('cc-by-4.0');
  });
});

describe('pickSidecar', () => {
  it('takes the metadata file named after the weights', () => {
    expect(pickSidecar(['lo_fi-v1.safetensors', 'lo_fi-v1.metadata.json', 'adapter_config.json'], 'lo_fi-v1.safetensors')).toEqual({ name: 'lo_fi-v1.metadata.json', ambiguous: false });
  });

  it('takes the only metadata file of the folder, whatever its name', () => {
    expect(pickSidecar(['a.safetensors', 'meta.metadata.json'], 'a.safetensors')).toEqual({ name: 'meta.metadata.json', ambiguous: false });
  });

  it('prefers the one that matches among several', () => {
    expect(pickSidecar(['a.metadata.json', 'b.metadata.json'], 'b.safetensors')).toEqual({ name: 'b.metadata.json', ambiguous: false });
    expect(pickSidecar(['A.METADATA.JSON', 'b.metadata.json'], 'a.safetensors').name).toBe('A.METADATA.JSON');
  });

  it('picks nothing, and says why, when several do not match: a wrong file is worse than none', () => {
    expect(pickSidecar(['x.metadata.json', 'y.metadata.json'], 'z.safetensors')).toEqual({ name: null, ambiguous: true });
  });

  it('stays in the folder of the weights', () => {
    expect(pickSidecar(['final/adapter_model.safetensors', 'final/adapter_model.metadata.json', 'other.metadata.json'], 'final/adapter_model.safetensors').name).toBe('final/adapter_model.metadata.json');
    expect(pickSidecar(['final/x.safetensors', 'root.metadata.json'], 'final/x.safetensors')).toEqual({ name: null, ambiguous: false });
  });

  it('finds none when there is none', () => {
    expect(pickSidecar(['a.safetensors', 'adapter_config.json', 'README.md'], 'a.safetensors')).toEqual({ name: null, ambiguous: false });
  });
});
