// utils/fillTemplate.ts
//
// Insere des valeurs dans un texte de traduction : « Failed ({{status}}) » avec { status: 500 } donne « Failed (500) ».
// Plusieurs textes n'avaient pas de place pour une valeur (une adresse, un code HTTP, une duree) : ils etaient ecrits en francais
// avec la valeur collee dans la phrase. Le marqueur {{nom}} laisse chaque langue placer la valeur ou sa grammaire l'exige.
//
// Un seul passage : un marqueur inconnu reste tel quel, et une valeur n'est jamais reinterpretee (ni « $& », ni un {{...}} imbrique).

export function fillTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (marker, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : marker,
  );
}
