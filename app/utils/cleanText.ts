// utils/cleanText.ts
//
// Texte sans espaces de bord ni caracteres invisibles. `trim()` ne retire pas les espaces de largeur nulle (U+200B a U+200D,
// U+2060), le BOM (U+FEFF) ni le trait d'union conditionnel (U+00AD) : un texte colle depuis un site ou un traitement de texte
// peut en contenir, la case parait vide et le champ est pourtant « rempli » pour l'application. Sert a decider si un champ
// est vide, pas a modifier ce que l'utilisateur a saisi.

const INVISIBLE = /[​-‍⁠﻿­]/g;

export function cleanText(value: string): string {
  return value.replace(INVISIBLE, '').trim();
}
