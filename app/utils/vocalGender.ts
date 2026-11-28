/**
 * Style text sent to the engine with the vocal gender chosen in the panel.
 *
 * The gender used to be appended as a last line ("Female vocals") even when the style said the opposite
 * ("A clear, earnest male vocal enters…"), so the DiT got two orders that contradict each other. Now a lead
 * vocal of the other gender named in the style is switched to the chosen one, and the hint line is only added
 * when the style does not already name the chosen gender for the vocals. Backing vocals, choirs and harmonies
 * keep their gender: a male lead with female backing vocals is a normal arrangement.
 */
export type ChosenVocalGender = 'male' | 'female' | '';

const VOCAL_NOUN = String.raw`(?:vocals?|voice|singer|vocalist|lead|crooner|rapper)`;
const GROUP_WORDS = /\b(?:backing|background|choir|chorus|harmon(?:y|ies)|ensemble|group|duet|backup)\b/i;
// "male", then up to three short words, then a vocal noun: "male vocal", "male lead vocals", "male, earnest voice".
// Not a compound ("male-dominated") and never across another gender word ("male …, female vocals").
const genderPhrase = (gender: string) =>
  new RegExp(
    String.raw`\b(${gender})\b(?!-)((?:[\s,]+(?!(?:fe)?male\b)[A-Za-z'-]{1,15}){0,3}?[\s,]+${VOCAL_NOUN})\b`,
    'gi',
  );

function matchCase(word: string, replacement: string): string {
  if (word === word.toUpperCase()) return replacement.toUpperCase();
  if (word[0] === word[0].toUpperCase()) return replacement[0].toUpperCase() + replacement.slice(1);
  return replacement;
}

export function alignVocalGender(style: string, gender: ChosenVocalGender): string {
  if (!gender || !style) return style;
  const other = gender === 'male' ? 'female' : 'male';
  return style.replace(genderPhrase(other), (whole, word: string, rest: string) =>
    GROUP_WORDS.test(rest) ? whole : matchCase(word, gender) + rest,
  );
}

export function styleWithVocalGender(style: string, gender: ChosenVocalGender): string {
  if (!gender) return style;
  const aligned = alignVocalGender(style, gender);
  const trimmed = aligned.trim();
  if (genderPhrase(gender).test(trimmed)) return aligned;
  const hint = gender === 'male' ? 'Male vocals' : 'Female vocals';
  return trimmed ? `${trimmed}\n${hint}` : hint;
}
