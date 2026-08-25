import React from 'react';
import { Plus, ChevronDown, Library, Upload } from 'lucide-react';
import { AUDIO_MODES, type AudioModeDef, type AudioModeId } from './CreatePanel';

interface AudioModeHeaderProps {
  activeAudioUrl: string;
  activeAudioMode: AudioModeDef;
  audioMode: AudioModeId;

  showAudioAddMenu: boolean;
  onToggleAudioAddMenu: () => void;
  audioAddMenuRef: React.RefObject<HTMLDivElement>;
  // Chacun regroupe la fermeture du menu ET l'action elle-meme — dans le
  // code d'origine, les deux se produisaient ensemble sur un seul clic.
  // CreatePanel implemente ces deux callbacks en conservant ce couplage ;
  // ce composant n'a plus besoin de connaitre setShowAudioAddMenu ni la ref
  // du champ de televersement.
  onSelectFromLibrary: () => void;
  onSelectUpload: () => void;

  showAudioMenu: boolean;
  onToggleAudioMenu: () => void;
  audioMenuRef: React.RefObject<HTMLDivElement>;
  onChangeAudioMode: (id: AudioModeId) => void;

  t: (key: string) => string;
  tf: (key: string, fallback: string) => string;
}

/**
 * En-tete du bloc AUDIO : libelle, menu "Ajouter" (bibliotheque/televersement,
 * masque des qu'un audio est charge), et le selecteur de mode (Remix/
 * Modification). Extrait du bloc AUDIO monolithique de CreatePanel — voir
 * AudioPlayerPanel pour le corps (lecteur + reglages contextuels), separe
 * en session du 25/08/2026 car le bloc combine depassait 30 props utiles.
 *
 * Composant presentationnel : tous les etats (showAudioAddMenu, audioMode,
 * etc.) restent dans CreatePanel, qui possede aussi les refs (necessaires
 * pour la detection de clic exterieur, geree par CreatePanel).
 */
export const AudioModeHeader: React.FC<AudioModeHeaderProps> = ({
  activeAudioUrl,
  activeAudioMode,
  audioMode,
  showAudioAddMenu,
  onToggleAudioAddMenu,
  audioAddMenuRef,
  onSelectFromLibrary,
  onSelectUpload,
  showAudioMenu,
  onToggleAudioMenu,
  audioMenuRef,
  onChangeAudioMode,
  t,
  tf,
}) => {
  const ActiveModeIcon = activeAudioMode.icon;

  return (
    <div className="px-3 py-2 border-b border-zinc-100 dark:border-white/5 bg-zinc-50 dark:bg-white/[0.02] flex items-center justify-between gap-2">
      <span className="text-[11px] font-bold text-zinc-500 dark:text-zinc-400 uppercase tracking-wide flex-shrink-0">
        {tf('audio', 'Audio')}
      </span>

      <div className="flex items-center gap-1 min-w-0">
        {!activeAudioUrl && (
          <div className="relative flex-shrink-0" ref={audioAddMenuRef}>
            <button
              type="button"
              onClick={onToggleAudioAddMenu}
              className="flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-medium text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-100 hover:bg-zinc-200 dark:hover:bg-white/10 transition-colors whitespace-nowrap"
            >
              <Plus size={11} className="flex-shrink-0" />
              <span>{tf('addAudio', 'Ajouter')}</span>
              <ChevronDown size={10} className={`flex-shrink-0 transition-transform ${showAudioAddMenu ? 'rotate-180' : ''}`} />
            </button>

            {showAudioAddMenu && (
              <div className="absolute left-0 top-full mt-1 z-50 w-52 rounded-xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#1f1f24] shadow-2xl overflow-hidden py-1">
                <button
                  type="button"
                  onClick={onSelectFromLibrary}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-zinc-100 dark:hover:bg-white/5 transition-colors"
                >
                  <Library size={14} className="text-zinc-400 flex-shrink-0" />
                  <span className="text-xs text-zinc-800 dark:text-zinc-100">{t('fromLibrary')}</span>
                </button>
                <button
                  type="button"
                  onClick={onSelectUpload}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-zinc-100 dark:hover:bg-white/5 transition-colors"
                >
                  <Upload size={14} className="text-zinc-400 flex-shrink-0" />
                  <span className="text-xs text-zinc-800 dark:text-zinc-100">{t('upload')}</span>
                </button>
              </div>
            )}
          </div>
        )}

        {/* Menu de mode */}
        <div className="relative min-w-0" ref={audioMenuRef}>
          <button
            type="button"
            onClick={onToggleAudioMenu}
            className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-zinc-100 dark:bg-white/5 border border-zinc-200 dark:border-white/10 text-[10px] font-semibold text-zinc-700 dark:text-zinc-200 hover:bg-zinc-200 dark:hover:bg-white/10 transition-colors max-w-full"
            title={`${activeAudioMode.label} — ${activeAudioMode.desc}`}
          >
            <ActiveModeIcon size={11} className="text-pink-500 flex-shrink-0" />
            <span className="truncate">{activeAudioMode.short}</span>
            <ChevronDown size={11} className={`flex-shrink-0 transition-transform ${showAudioMenu ? 'rotate-180' : ''}`} />
          </button>

          {showAudioMenu && (
            <div className="absolute right-0 top-full mt-1 z-50 w-72 rounded-xl border border-zinc-200 dark:border-white/10 bg-white dark:bg-[#1f1f24] shadow-2xl overflow-hidden py-1">
              {(['remix', 'edit'] as const).map((group) => (
                <div key={group}>
                  <div className="px-3 pt-2 pb-1 text-[9px] font-bold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                    {group === 'remix' ? (tf('remix', 'Remix')) : (tf('modification', 'Modification'))}
                  </div>
                  {AUDIO_MODES.filter((m) => m.group === group).map((m) => {
                    const Icon = m.icon;
                    const isActive = m.id === audioMode;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        disabled={!m.available}
                        onClick={() => onChangeAudioMode(m.id)}
                        className={`w-full flex items-start gap-2.5 px-3 py-2 text-left transition-colors ${
                          !m.available
                            ? 'opacity-40 cursor-not-allowed'
                            : isActive
                              ? 'bg-pink-500/10'
                              : 'hover:bg-zinc-100 dark:hover:bg-white/5'
                        }`}
                      >
                        <Icon size={14} className={`mt-0.5 flex-shrink-0 ${isActive ? 'text-pink-500' : 'text-zinc-400'}`} />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span className={`text-xs font-medium ${isActive ? 'text-pink-500' : 'text-zinc-800 dark:text-zinc-100'}`}>
                              {m.label}
                            </span>
                            {!m.available && (
                              <span className="text-[8px] uppercase font-bold px-1 py-px rounded bg-zinc-200 dark:bg-white/10 text-zinc-500 dark:text-zinc-400">
                                {tf('soon', 'bientot')}
                              </span>
                            )}
                          </span>
                          <span className="block text-[10px] text-zinc-500 dark:text-zinc-400 leading-tight mt-0.5">
                            {m.desc}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
