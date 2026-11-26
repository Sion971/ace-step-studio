// The audio modes of the Create panel (one audio field, one mode menu). Taken out of CreatePanel.tsx as is.
import type React from 'react';
import { Sparkles, RefreshCw, Disc3, Wand2, Scissors, Repeat, Gauge, Layers, ArrowRightToLine, Blocks, Split, Puzzle } from 'lucide-react';
import type { TranslationKey } from '../i18n/translations';

// ---------------------------------------------------------------------------
// AUDIO MODES — un seul emplacement audio, un menu de mode (façon Suno).
//
// `field`    : dans quelle case du payload part l'URL (contrat backend inchangé)
// `taskType` : la valeur envoyee au pipeline quand un audio est charge
// `available`: false = visible dans le menu mais grise (pas encore branche)
//
// Reference et Cover ne peuvent PAS coexister : le pipeline n'arbitre que sur
// `taskType`, qui est unique. Le menu rend cette exclusivite explicite.
// ---------------------------------------------------------------------------
export type AudioModeId =
  | 'cover' | 'inspiration' | 'mashup' | 'sample'
  | 'extend' | 'repaint' | 'crop' | 'reverse' | 'speed'
  | 'lego' | 'extract' | 'complete';

export interface AudioModeDef {
  id: AudioModeId;
  group: 'remix' | 'edit' | 'tracks';
  field: 'reference' | 'source';
  taskType: string;
  // Textes affiches : des CLES de traduction (TranslationKey, donc verifiees a la compilation). Ils etaient ecrits en francais dans
  // cette table et s'affichaient tels quels dans toutes les langues.
  labelKey: TranslationKey;
  // Libelle court affiche sur le bouton d'en-tete, ou la place est comptee.
  // « Remplacer une section » debordait du panneau.
  shortKey: TranslationKey;
  descKey: TranslationKey;
  icon: React.ComponentType<{ size?: number | string; className?: string }>;
  available: boolean;
}

export const AUDIO_MODES: AudioModeDef[] = [
  // --- REMIX -------------------------------------------------------------
  { id: 'cover',       group: 'remix', field: 'source',    taskType: 'cover',
    labelKey: 'audioModeCover', shortKey: 'audioModeCover', descKey: 'audioModeCoverDesc',
    icon: RefreshCw, available: true },
  { id: 'inspiration', group: 'remix', field: 'reference', taskType: 'text2music',
    labelKey: 'audioModeInspiration', shortKey: 'audioModeInspiration', descKey: 'audioModeInspirationDesc',
    icon: Sparkles, available: true },
  { id: 'mashup',      group: 'remix', field: 'source',    taskType: 'cover',
    labelKey: 'audioModeMashup', shortKey: 'audioModeMashup', descKey: 'audioModeMashupDesc',
    icon: Layers, available: false },
  { id: 'sample',      group: 'remix', field: 'source',    taskType: 'repaint',
    labelKey: 'audioModeSample', shortKey: 'audioModeSample', descKey: 'audioModeSampleDesc',
    icon: Disc3, available: true },
  // --- MODIFICATION ------------------------------------------------------
  { id: 'repaint',     group: 'edit',  field: 'source',    taskType: 'repaint',
    labelKey: 'audioModeRepaint', shortKey: 'audioModeRepaintShort', descKey: 'audioModeRepaintDesc',
    icon: Wand2, available: true },
  { id: 'extend',      group: 'edit',  field: 'source',    taskType: 'repaint',
    labelKey: 'audioModeExtend', shortKey: 'audioModeExtend', descKey: 'audioModeExtendDesc',
    icon: ArrowRightToLine, available: true },
  { id: 'crop',        group: 'edit',  field: 'source',    taskType: 'cover',
    labelKey: 'audioModeCrop', shortKey: 'audioModeCrop', descKey: 'audioModeCropDesc',
    icon: Scissors, available: true },
  { id: 'reverse',     group: 'edit',  field: 'source',    taskType: 'cover',
    labelKey: 'audioModeReverse', shortKey: 'audioModeReverse', descKey: 'audioModeReverseDesc',
    icon: Repeat, available: true },
  { id: 'speed',       group: 'edit',  field: 'source',    taskType: 'cover',
    labelKey: 'audioModeSpeed', shortKey: 'audioModeSpeed', descKey: 'audioModeSpeedDesc',
    icon: Gauge, available: true },
  // --- PISTES (modele base pur uniquement : voir isPureBaseModel) ---------
  { id: 'lego',        group: 'tracks', field: 'source',   taskType: 'lego',
    labelKey: 'audioModeLego', shortKey: 'audioModeLego', descKey: 'audioModeLegoDesc',
    icon: Blocks, available: true },
  { id: 'extract',     group: 'tracks', field: 'source',   taskType: 'extract',
    labelKey: 'audioModeExtract', shortKey: 'audioModeExtract', descKey: 'audioModeExtractDesc',
    icon: Split, available: true },
  { id: 'complete',    group: 'tracks', field: 'source',   taskType: 'complete',
    labelKey: 'audioModeComplete', shortKey: 'audioModeComplete', descKey: 'audioModeCompleteDesc',
    icon: Puzzle, available: true },
];

export const isTrackTask = (task: string) => task === 'lego' || task === 'extract' || task === 'complete';

export const AUDIO_MODE_MAP = AUDIO_MODES.reduce((acc, m) => {
  acc[m.id] = m;
  return acc;
}, {} as Record<AudioModeId, AudioModeDef>);
