import { describe, expect, it } from 'vitest';
import { alignVocalGender, styleWithVocalGender } from './vocalGender';

const DANS_SES_PAS = 'A bright, clean piano ballad. A clear, earnest male vocal enters, singing in French with a pop sensibility.';

describe('styleWithVocalGender', () => {
  it('switches a lead vocal of the other gender instead of adding a contradicting line', () => {
    // seen in the engine log: "…male vocal enters…" followed by a last line "Female vocals"
    const out = styleWithVocalGender(DANS_SES_PAS, 'female');
    expect(out).toContain('earnest female vocal enters');
    expect(out).not.toMatch(/\bmale vocal/);
    expect(out).not.toContain('Female vocals');
  });

  it('adds the hint line when the style names no vocal gender', () => {
    expect(styleWithVocalGender('synth-pop, 80s', 'male')).toBe('synth-pop, 80s\nMale vocals');
    expect(styleWithVocalGender('', 'female')).toBe('Female vocals');
  });

  it('does not repeat a gender the style already names', () => {
    expect(styleWithVocalGender('soulful female lead vocals', 'female')).toBe('soulful female lead vocals');
  });

  it('changes nothing without a chosen gender', () => {
    expect(styleWithVocalGender(DANS_SES_PAS, '')).toBe(DANS_SES_PAS);
  });
});

describe('alignVocalGender', () => {
  it('handles a few words between the gender and the vocal noun, and keeps the case', () => {
    expect(alignVocalGender('Female lead vocals soar.', 'male')).toBe('Male lead vocals soar.');
    expect(alignVocalGender('a male, breathy voice', 'female')).toBe('a female, breathy voice');
    expect(alignVocalGender('MALE VOCALS', 'female')).toBe('FEMALE VOCALS');
  });

  it('keeps backing vocals, choirs and harmonies of the other gender', () => {
    const text = 'male lead vocal with female backing vocals and a female choir';
    expect(alignVocalGender(text, 'male')).toBe(text);
    expect(alignVocalGender('female harmony vocals', 'male')).toBe('female harmony vocals');
  });

  it('does not touch "female" when switching "male", nor words that are not about the voice', () => {
    expect(alignVocalGender('female vocals', 'female')).toBe('female vocals');
    expect(alignVocalGender('a male-dominated scene, female vocals', 'female')).toBe('a male-dominated scene, female vocals');
  });
});
