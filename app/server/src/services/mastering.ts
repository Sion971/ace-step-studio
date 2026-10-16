// services/mastering.ts
//
// Chaine de mastering appliquee par ffmpeg AVANT la normalisation de loudness
// (routes/loudnorm.ts). Cinq reglages, tous de 0 a 100 sauf la tonalite
// (-100 a +100) ; 0 partout = aucun traitement (le fichier passe tel quel
// dans la normalisation, comme avant).
//
//   warmth     saturation douce (tanh) en parallele : ajoute des harmoniques aux
//              cretes, sans toucher aux passages doux ;
//   harmonics  aexciter : harmoniques ajoutees dans les aigus (« air ») ;
//   tone       bascule les graves/aigus de quelques dB (sombre <-> brillant) ;
//   glue       compression douce qui resserre la dynamique du mix ;
//   width      elargit l'image stereo (au plus x1,4).
//
// Ordre : coupe-bas, tonalite, chaleur, harmoniques, compression, largeur.

export interface MasteringSettings {
  harmonics: number;
  warmth: number;
  tone: number;
  glue: number;
  width: number;
}

export const NO_MASTERING: MasteringSettings = { harmonics: 0, warmth: 0, tone: 0, glue: 0, width: 0 };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function field(body: Record<string, unknown> | undefined, name: keyof MasteringSettings, min: number, max: number): number {
  const raw = body?.[name];
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw ?? ''));
  return Number.isFinite(n) ? clamp(n, min, max) : 0;
}

/** Reads the five settings from a request body (multipart fields arrive as strings); anything missing or not a number is 0. */
export function parseMasteringSettings(body: Record<string, unknown> | undefined): MasteringSettings {
  return {
    harmonics: field(body, 'harmonics', 0, 100),
    warmth: field(body, 'warmth', 0, 100),
    tone: field(body, 'tone', -100, 100),
    glue: field(body, 'glue', 0, 100),
    width: field(body, 'width', 0, 100),
  };
}

export function isMasteringActive(s: MasteringSettings): boolean {
  return s.harmonics >= 1 || s.warmth >= 1 || Math.abs(s.tone) >= 1 || s.glue >= 1 || s.width >= 1;
}

const n2 = (x: number) => x.toFixed(2);

/** The ffmpeg filter chain for these settings, without a trailing comma; an empty string when nothing is to be done. */
export function buildMasteringFilter(s: MasteringSettings): string {
  if (!isMasteringActive(s)) return '';
  const parts: string[] = ['highpass=f=25'];

  if (Math.abs(s.tone) >= 1) {
    // +100 = aigus +3 dB et graves -1,5 dB ; -100 = l'inverse.
    parts.push(`treble=g=${n2(s.tone * 0.03)}:f=6000`);
    parts.push(`bass=g=${n2(-s.tone * 0.015)}:f=120`);
  }

  if (s.warmth >= 1) {
    // Le signal est pousse de `drive` dB dans un ecreteur doux (tanh), ramene a son niveau, puis melange au signal sec :
    // les passages doux restent lineaires, seules les cretes se chargent en harmoniques.
    const drive = 2 + s.warmth * 0.08;
    const wet = (s.warmth / 100) * 0.5;
    parts.push(
      `asplit=2[dry][wet];[wet]volume=${n2(drive)}dB,asoftclip=type=tanh,volume=-${n2(drive)}dB[sat];` +
      `[dry][sat]amix=inputs=2:weights=${(1 - wet).toFixed(3)} ${wet.toFixed(3)}:normalize=0`,
    );
  }

  if (s.harmonics >= 1) {
    parts.push(`aexciter=amount=${n2(Math.max(0.1, (s.harmonics / 100) * 3))}:drive=8.5:blend=0:freq=7500:ceil=16000`);
  }

  if (s.glue >= 1) {
    const g = s.glue / 100;
    parts.push(`acompressor=threshold=${n2(-12 - g * 10)}dB:ratio=${n2(1.4 + g * 1.6)}:attack=30:release=250:makeup=1`);
  }

  if (s.width >= 1) {
    parts.push(`extrastereo=m=${n2(1 + (s.width / 100) * 0.4)}:c=0`);
  }

  return parts.join(',');
}

/** Peak ceiling (linear) for the final limiter, from a true-peak target in dBTP. */
export function limiterCeiling(targetTP: number): number {
  return clamp(Math.pow(10, targetTP / 20), 0.0625, 1);
}
