// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { sortByName } from './sortByName';

describe('sortByName', () => {
  it('sorts by name, ignoring accents and case, with numbers in natural order', () => {
    const names = ['zouk', 'Été', 'Démo 10', 'au-delà', 'Démo 2', 'ete bis', 'Bachata'];
    expect(sortByName(names.map(name => ({ name }))).map(p => p.name))
      .toEqual(['au-delà', 'Bachata', 'Démo 2', 'Démo 10', 'Été', 'ete bis', 'zouk']);
  });

  it('leaves the list it was given as it was', () => {
    const list = [{ name: 'b' }, { name: 'a' }];
    sortByName(list);
    expect(list.map(p => p.name)).toEqual(['b', 'a']);
  });
});
