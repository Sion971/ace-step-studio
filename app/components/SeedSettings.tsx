import React from 'react';
import { Dices, Hash, RefreshCw } from 'lucide-react';

interface SeedSettingsProps {
  /** Graine de generation. -1 vaut « aleatoire » cote moteur. */
  seed: number;
  randomSeed: boolean;
  onSeedChange: (value: number) => void;
  /** Bascule fixe/aleatoire. Tire une graine reelle en passant sur « fixe » ;
   *  la logique reste dans CreatePanel, ce composant ne fait que l'appeler. */
  onToggleRandomSeed: () => void;

  /** Lu seulement pour l'avertissement : au-dela d'une variante, seul le
   *  premier job suit la graine (`randomSeed || i > 0` dans handleGenerate). */
  bulkCount: number;

  retakeEnabled: boolean;
  retakeVariance: number;
  retakeSeed: string;
  onRetakeEnabledChange: (value: boolean) => void;
  onRetakeVarianceChange: (value: number) => void;
  onRetakeSeedChange: (value: string) => void;

  t: (key: string) => string;
  /** Repli quand la cle i18n manque — `t()` renvoie la cle elle-meme. */
  tf: (key: string, fallback: string) => string;
}

/**
 * Graine de generation et « Nouvelle prise ».
 *
 * Les deux panneaux portaient le mot « graine » sans se distinguer, d'ou des
 * tests non reproductibles pendant toute une session. Ils sont regroupes ici
 * dans leur ordre logique : la graine de generation d'abord, la variation qui
 * en derive ensuite.
 *
 * Composant presentationnel : les six etats restent dans CreatePanel, qui les
 * lit a la construction de la charge utile.
 *
 * Voir TROUBLESHOOTING #16 et #17 pour les quatre pieges couverts par les
 * avertissements affiches ici.
 */
export const SeedSettings: React.FC<SeedSettingsProps> = ({
  seed,
  randomSeed,
  onSeedChange,
  onToggleRandomSeed,
  bulkCount,
  retakeEnabled,
  retakeVariance,
  retakeSeed,
  onRetakeEnabledChange,
  onRetakeVarianceChange,
  onRetakeSeedChange,
  t,
  tf,
}) => {
  return (
    <>
        {/* ── GRAINE DE GENERATION ─────────────────────────────────────
            Placee AVANT « Nouvelle prise », qui en derive. Les deux
            portaient le mot « graine » sans se distinguer. */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Dices size={14} className="text-zinc-500" />
              <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400" title={tf('hintSeed', 'Fixing the seed makes results repeatable. Random is recommended for variety.')}>
                {tf('generationSeed', 'Graine de génération')}
              </span>
            </div>
            <button
              onClick={onToggleRandomSeed}
              className={`w-10 h-5 rounded-full flex items-center transition-colors duration-200 px-0.5 border border-zinc-200 dark:border-white/5 ${randomSeed ? 'bg-pink-600' : 'bg-zinc-300 dark:bg-black/40'}`}
            >
              <div className={`w-4 h-4 rounded-full bg-white transform transition-transform duration-200 shadow-sm ${randomSeed ? 'translate-x-5' : 'translate-x-0'}`} />
            </button>
          </div>
          <div className="flex items-center gap-2">
            <Hash size={14} className="text-zinc-500" />
            <input
              type="number"
              value={seed}
              onChange={(e) => onSeedChange(Number(e.target.value))}
              placeholder={t('enterFixedSeed')}
              disabled={randomSeed}
              className={`flex-1 bg-zinc-50 dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-3 py-1.5 text-xs text-zinc-900 dark:text-white focus:outline-none ${randomSeed ? 'opacity-40 cursor-not-allowed' : ''}`}
            />
            {!randomSeed && (
              <button
                type="button"
                onClick={() => onSeedChange(Math.floor(Math.random() * 4294967295))}
                title={tf('rerollSeed', 'Tirer une nouvelle graine')}
                className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-200 dark:hover:bg-white/10 transition-colors"
              >
                <RefreshCw size={13} />
              </button>
            )}
          </div>
          <p className="text-[10px] text-zinc-500">
            {randomSeed ? t('randomSeedRecommended') : t('fixedSeedReproducible')}
          </p>

          {/* Piege n°1 : -1 vaut « aléatoire » cote moteur. */}
          {!randomSeed && (seed === -1 || seed === 0) && (
            <p className="text-[10px] text-amber-500">
              {tf('warnSeedMinusOne', '-1 est interprété comme aléatoire par le moteur : saisis un nombre réel pour figer le résultat.')}
            </p>
          )}

          {/* Piege n°2 : `randomSeed || i > 0` — seul le premier job suit la graine. */}
          {!randomSeed && bulkCount > 1 && (
            <p className="text-[10px] text-amber-500">
              {tf('warnSeedBulk', 'Seule la 1re variante utilise cette graine ; les suivantes repassent en aléatoire. Mets le nombre de variantes à 1 pour un test reproductible.')}
            </p>
          )}
        </div>

        {/* ── NOUVELLE PRISE ───────────────────────────────────────────
            Replie tant qu'elle est eteinte : plus de champ grise sans
            explication. */}
        <div className="rounded-xl border border-zinc-200 dark:border-white/10 bg-zinc-50/50 dark:bg-black/10 p-3 space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
              {tf('retakeLabel', 'Nouvelle prise')}
            </label>
            <button
              type="button"
              onClick={() => {
                const next = !retakeEnabled;
                onRetakeEnabledChange(next);
                if (next && retakeVariance === 0) onRetakeVarianceChange(0.5);
              }}
              className={`w-10 h-5 rounded-full flex items-center transition-colors duration-200 px-0.5 border border-zinc-200 dark:border-white/5 ${retakeEnabled ? 'bg-pink-600' : 'bg-zinc-300 dark:bg-black/40'}`}
            >
              <div className={`w-4 h-4 rounded-full bg-white transform transition-transform duration-200 shadow-sm ${retakeEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
            </button>
          </div>
          <p className="text-[10px] text-zinc-500">
            {tf('hintRetake', 'Régénère le même morceau avec une variation dosée, à partir de la graine de génération.')}
          </p>

          {retakeEnabled && (
            <div className="grid grid-cols-2 gap-2 pt-1">
              <div className="space-y-1">
                <label className="text-[11px] text-zinc-600 dark:text-zinc-400 flex justify-between">
                  <span>{tf('retakeVarianceLabel', 'Variance')}</span>
                  <span className="text-zinc-500">{retakeVariance.toFixed(2)}</span>
                </label>
                <input
                  type="range" min={0} max={1} step={0.01}
                  value={retakeVariance}
                  onChange={(e) => onRetakeVarianceChange(Number(e.target.value))}
                  className="w-full accent-pink-500"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[11px] text-zinc-600 dark:text-zinc-400">
                  {tf('retakeSeedLabel', 'Graine de la variation')}
                </label>
                <input
                  type="text"
                  value={retakeSeed}
                  onChange={(e) => onRetakeSeedChange(e.target.value.replace(/[^0-9-]/g, ''))}
                  placeholder="-1"
                  className="w-full bg-white dark:bg-black/20 border border-zinc-200 dark:border-white/10 rounded-lg px-2 py-1 text-xs text-zinc-900 dark:text-white focus:outline-none focus:border-pink-500"
                />
              </div>
            </div>
          )}

          {/* Mesure : variance 1.00 + graine -1 fait passer l'exces de haute
              frequence de -0.7 % a +22.8 % par rapport a la source. C'est de
              loin la premiere cause d'artefacts, devant tous les autres
              reglages de reprise. */}
          {retakeEnabled && retakeVariance > 0.7 && (
            <p className="text-[10px] text-amber-500">
              {tf('warnRetakeVariance', 'Variance élevée : ajoute un tirage de bruit indépendant, principale cause d\'artefacts mesurée. Reste sous 0,70 sauf variation volontairement radicale.')}
            </p>
          )}

          {retakeEnabled && !randomSeed && retakeSeed.trim() === '-1' && (
            <p className="text-[10px] text-amber-500">
              {tf('warnRetakeSeedRandom', 'Graine de variation à -1 : la prise reste aléatoire malgré la graine de génération fixée.')}
            </p>
          )}
        </div>
    </>
  );
};
