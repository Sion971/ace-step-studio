import { describe, expect, it } from 'vitest';
import { safeDatasetFileName, savePathForName } from './datasetPaths';

describe('dataset paths', () => {
  it('keeps the folder and swaps the file name', () => {
    expect(savePathForName('./datasets/my_lora_dataset.json', 'mercy')).toBe('./datasets/mercy.json');
    expect(savePathForName('C:\\data\\old.json', 'mercy')).toBe('C:\\data\\mercy.json');
    expect(savePathForName('/home/me/sets/old.json', 'mercy')).toBe('/home/me/sets/mercy.json');
  });
  it('falls back to ./datasets/ when the path has no folder', () => {
    expect(savePathForName('old.json', 'mercy')).toBe('./datasets/mercy.json');
    expect(savePathForName('', 'mercy')).toBe('./datasets/mercy.json');
  });
  it('leaves the path alone while the name is empty', () => {
    expect(savePathForName('./datasets/a.json', '   ')).toBe('./datasets/a.json');
  });
  it('removes characters a file name cannot hold', () => {
    expect(safeDatasetFileName(' my:set/1 ')).toBe('my_set_1');
    expect(savePathForName('./datasets/a.json', '../x')).toBe('./datasets/_x.json');
  });
});
