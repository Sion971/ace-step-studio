// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { fr } from './fr';

// fr.ts is the French the interface shows. Read against a French word list (969 keys), it had exactly three values written without
// accents — "Desactiver", "reactive", "reinitialisation", "redemarrage", "decharge" — all in the quantization texts of the LoRA panel.
// One of them was also wrong, not only unaccented: it said that RE-enabling takes about a minute, while the server re-initializes the
// service in BOTH directions (routes/lora.ts calls callInitServiceWrapper whether `enabled` is true or false).
//
// The list is words that are not French (and not English) without their accent, so a hit is never a false alarm. It is a guard against
// the same words coming back, not a spell-checker: a French word missing an accent that is not listed here would pass.
const UNACCENTED = /\b(desactiv\w*|reactiv\w*|reinitialis\w*|redemarr\w*|decharg\w*|telecharg\w*|echec\w*|deja|apres|etape\w*|resultat\w*|parametr\w*|qualite|selectionn\w*)\b/i;

describe('French texts keep their accents', () => {
  it('has no listed word written without its accent', () => {
    const offenders = Object.entries(fr)
      .filter(([, value]) => typeof value === 'string' && UNACCENTED.test(value))
      .map(([key, value]) => `${key}: ${String(value).slice(0, 90)}`);
    expect(offenders, 'a French word is missing its accent in fr.ts').toEqual([]);
  });

  it('says the right thing about the quantization toggle', () => {
    expect(fr.quantizationToggleHint).toContain('Désactiver');
    expect(fr.quantizationToggleHint).toContain('chaque changement prend environ 1 minute');
    expect(fr.quantizationToggleHint).toContain('réinitialisation du service');
    expect(fr.quantizationToggleHint).not.toContain('réactive prend');
    expect(fr.quantizationBlocksLora).toContain('désactivez-la');
    expect(fr.quantizationAutoUnloadedLora).toContain('déchargé');
  });
});
