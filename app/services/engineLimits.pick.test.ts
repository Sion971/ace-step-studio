import { describe, expect, it } from 'vitest';
import { pickMaxDuration } from './engineLimits';

describe('pickMaxDuration', () => {
  const limits = { withLm: 480, withoutLm: 600 };
  it('uses the "with LM" limit as soon as the language model is loaded, whatever the thinking switch says', () => {
    expect(pickMaxDuration(limits, true)).toBe(480);
  });
  it('uses the "without LM" limit when the engine runs without a language model', () => {
    expect(pickMaxDuration(limits, false)).toBe(600);
  });
  it('takes the lower limit until the server has said whether the model is loaded', () => {
    expect(pickMaxDuration(limits, null)).toBe(480);
    expect(pickMaxDuration({ withLm: 240, withoutLm: 360 }, null)).toBe(240);
  });
});
