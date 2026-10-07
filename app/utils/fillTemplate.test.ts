// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { fillTemplate } from './fillTemplate';

describe('fillTemplate', () => {
  it('inserts one value', () => {
    expect(fillTemplate('Failed ({{status}}).', { status: 500 })).toBe('Failed (500).');
  });

  it('inserts several values, in any order, and the same marker more than once', () => {
    expect(fillTemplate('{{count}} stems in {{seconds}} s', { seconds: 12, count: 4 })).toBe('4 stems in 12 s');
    expect(fillTemplate('{{a}} and {{a}}', { a: 'x' })).toBe('x and x');
  });

  it('keeps zero, and an empty string', () => {
    expect(fillTemplate('{{n}} left', { n: 0 })).toBe('0 left');
    expect(fillTemplate('[{{s}}]', { s: '' })).toBe('[]');
  });

  it('leaves an unknown marker as it is, rather than printing "undefined"', () => {
    expect(fillTemplate('File: {{url}}', {})).toBe('File: {{url}}');
    expect(fillTemplate('{{a}} {{b}}', { a: 1 })).toBe('1 {{b}}');
  });

  it('never reinterprets a value (replacement patterns, nested markers)', () => {
    expect(fillTemplate('Name: {{name}}', { name: "$& and $1 and $'" })).toBe("Name: $& and $1 and $'");
    expect(fillTemplate('{{a}}', { a: '{{b}}', b: 'LEAK' })).toBe('{{b}}');
  });

  it('copes with an empty template and with text that has no marker', () => {
    expect(fillTemplate('', { a: 1 })).toBe('');
    expect(fillTemplate('Nothing to fill', { a: 1 })).toBe('Nothing to fill');
  });

  it('handles an address with characters that matter in a regular expression', () => {
    expect(fillTemplate('HTTP {{status}} on {{url}}', { status: 404, url: '/audio/a+b (1).mp3?x=1&y=$z' })).toBe('HTTP 404 on /audio/a+b (1).mp3?x=1&y=$z');
  });
});
