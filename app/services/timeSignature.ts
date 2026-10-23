// services/timeSignature.ts
//
// ACE-Step takes the time signature as the number 2, 3, 4 or 6 (2/4, 3/4, 4/4, 6/8; empty = automatic) and gives the same number back, but some of its
// replies already say "4/4". The interface shows the full form everywhere so that the same song never reads "4" in one place and "4/4" in another.
// Only the display changes: the value kept and sent to the engine stays the number.

const FULL_FORM: Record<string, string> = { '2': '2/4', '3': '3/4', '4': '4/4', '6': '6/8' };

/** "4" → "4/4", "6" → "6/8"; a form that is already complete ("4/4", "7/8"), "N/A" or an unknown text is returned as it is. */
export function formatTimeSignature(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value).trim();
  return FULL_FORM[text] ?? text;
}
