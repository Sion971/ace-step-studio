# CreatePanel.tsx — cartographie et plan de découpage

*Actualisé le 17 août 2026, après la session « cover / graine ».*

## Mesures

| indicateur | valeur | précédent relevé | repère sain |
|---|---|---|---|
| lignes | **4 074** | 4 157 | < 300 |
| déclarations `useState` | **126** | 105 | 5–15 |
| `useEffect` | 22 | 23 | 2–5 |
| `useRef` | 30 | 15 | 1–3 |
| `useCallback` | 10 | 8 | — |
| `useMemo` | 2 | 2 | — |
| props | 14 | 14 | 3–7 |

*Méthode de comptage :* déclarations réelles, motif
`const [x, setX] = useState`, et non occurrences textuelles du mot — le relevé
précédent mélangeait probablement les deux, d'où l'écart apparent sur `useRef`.

Le nombre de lignes a peu bougé, mais il masque deux mouvements opposés :
`ModelMenu.tsx` a été extrait (~195 lignes en moins), tandis que la session
cover/graine a ajouté le bloc AUDIO unifié, les avertissements de graine et le
helper `tf()`.

**126 états dans un composant, c'est le symptôme central.** Chaque rendu
réévalue tout, chaque modification touche un fichier que personne ne peut tenir
en tête, et les collisions deviennent structurelles. Les 10 `useCallback` pour
126 états signalent que presque aucune fonction n'est stabilisée : tout enfant
recevant un handler se re-rend à chaque frappe clavier.

---

## Ce qui a déjà été extrait

- **`ModelMenu.tsx`** — sélection et bascule de modèle (~195 lignes). L'ancienne
  *étape 2* du plan est donc faite.
- **`LmProviderPanel.tsx`**, **`PollinationsPanel.tsx`**,
  **`GenerationStatusPanel.tsx`**, **`LoraPanel.tsx`** — extraits, mais
  `LoraPanel` remonte encore `loraLoaded` au parent.
- **`utils/modelNames.ts`** — `getModelDisplayName`, `MODEL_INFO`,
  `isTurboModel`, `getModelVramMin`, partagés avec `SongList.tsx`.

---

## Groupes d'états identifiés

Onze familles nettes. C'est ce découpage naturel qui rend l'extraction possible
sans réarchitecture.

### A. Contenu principal
`songDescription`, `lyrics`, `style`, `title`
→ cœur du formulaire, reste dans le composant parent.
`customMode` supprimé avec le mode Simple.

### B. Voix et métadonnées musicales
`instrumental`, `vocalLanguage`, `vocalGender`, `bpm`, `keyScale`,
`timeSignature`
→ **`<VocalSettings />`** — 6 états

### C. Réglages rapides
`showAdvanced`, `duration`, `batchSize`, `bulkCount`, `guidanceScale`,
`randomSeed`, `seed`, `thinking`, `enhance`, `audioFormat`, `inferenceSteps`,
`inferMethod`
→ **`<QuickSettings />`** — 12 états

### D. Modèle de langue
`lmBackend`, `lmModel`, `activeLmModel`, `useOpenRouter`,
`lastOpenRouterModelId`, `usePollinations`, `showLmParams`, `lmTemperature`,
`lmCfgScale`, `lmTopK`, `lmTopP`, `lmNegativePrompt`
→ **`<LmSettings />`** — 12 états, déjà partiellement isolé dans
`LmProviderPanel.tsx`

### E. Audio de référence et cover — **refondu**
`referenceAudioUrl`, `sourceAudioUrl`, `referenceAudioTitle`,
`sourceAudioTitle`, `audioMode`, `showAudioMenu`, `audioCodes`,
`repaintingStart`, `repaintingEnd`, `instruction`, `audioCoverStrength`,
`coverNoiseStrength`, `taskType`, `useAdg`, `cfgIntervalStart`,
`cfgIntervalEnd`, `customTimesteps`
→ **`<AudioPanel />`** — 17 états

La double implémentation Référence / Cover **n'existe plus** : un emplacement
unique piloté par un menu de mode (`AUDIO_MODES` au niveau module), sur le
modèle de Suno. `audioTab` a disparu, le toggle Cover/Repaint aussi, et le
sélecteur `taskType` des avancés est devenu un affichage dérivé.

Le `taskType` découle désormais du mode via `AUDIO_MODE_MAP[audioMode]`, ce qui
supprime la seconde source de vérité. C'est la zone qui a produit le bug de
glisser-déposer, puis celui de l'instruction codée en dur (TROUBLESHOOTING §15).

### F. Chain-of-thought et options LM avancées
`useCotMetas`, `useCotCaption`, `useCotLanguage`, `autogen`,
`constrainedDecodingDebug`, `allowLmBatch`, `getScores`, `getLrc`,
`scoreScale`, `lmBatchChunkSize`, `trackName`, `completeTrackClasses`,
`isFormatCaption`
→ rattachable à **`<LmSettings />`** — 13 états

### G. Échantillonnage et qualité
`samplerMode`, `schedulerType`, `dcwEnabled`, `dcwMode`, `dcwScaler`,
`dcwHighScaler`, `dcwWavelet`, `retakeSeed`, `retakeVariance`,
`retakeEnabled`, `flowEditMorph`, `flowEditSourceCaption`,
`flowEditSourceLyrics`, `flowEditNMin`, `flowEditNMax`, `flowEditNAvg`,
`mp3Bitrate`, `mp3SampleRate`, `fadeInDuration`, `fadeOutDuration`,
`repaintMode`, `repaintStrength`
→ **`<AdvancedSettings />`** — 22 états, le plus gros bloc

Panneau réordonné depuis la session graine : « Graine de génération » précède
désormais « Nouvelle prise », qui en dérive et possède son propre interrupteur.

### H. LoRA
`showLoraPanel`, `loraPath`, `loraLoaded`, `loraEnabled`, `loraScale`,
`loraError`, `isLoraLoading`
→ **`<LoraPanel />`** — extrait ; seul `loraLoaded` remonte encore

### I. Sélection de modèle
`selectedModel`, `showModelMenu`, `modelSwitchStatus`, `modelLoadingState`,
`fetchedModels`
→ **`<ModelMenu />`** — extrait. `modelSwitchProgress` supprimé (état mort)

### J. Upload et transferts
`isUploadingReference`, `isUploadingSource`, `isTranscribingReference`,
`uploadError`, `isFormattingStyle`, `isFormattingLyrics`, `isDraggingFile`,
`dragKind`, `showAudioModal`
→ rattachable à **`<AudioPanel />`** — 9 états

### K. Divers
`musicTags`, `serverPollSeen`, `shift`, `maxDurationWithLm`,
`maxDurationWithoutLm`, `lyricsHeight`, `isResizing`
→ reste au parent ou passe en contexte

---

## Repères de position dans le fichier

| bloc | ligne approximative |
|---|---|
| déclarations d'états | 260 – 1060 |
| `<ModelMenu />` | 1965 |
| description du morceau | ~2000 |
| bloc AUDIO unifié | ~2140 – 2350 |
| paroles | 2350 |
| `<LoraPanel />` | 2653 |
| réglages avancés (`showAdvanced`) | 2674 → fin |
| graine de génération | 3150 |
| nouvelle prise | 3208 |

Ces numéros bougent à chaque modification : les traiter comme des points de
repère, pas comme des adresses.

---

## Plan de découpage — ordre recommandé

L'ordre suit le **risque croissant** : on commence par les blocs les plus
isolés, dont l'extraction ne peut rien casser ailleurs.

### ~~Étape 1 — `<LoraPanel />`~~ — faite
### ~~Étape 2 — `<ModelSelector />`~~ — faite, sous le nom `ModelMenu.tsx`

### ~~Étape 3 — Retirer Simple / Personnalisé~~ — faite
Le sélecteur, l'état `customMode` et ses six branchements ont disparu ; la
description « Décrivez votre chanson » a été remontée dans le panneau unifié.
La charge utile parallèle (TROUBLESHOOTING §12) n'existe plus.
Trois pièges découverts au passage — 400 silencieux, bouton mort, échec de
pré-vol fatal — sont documentés en **TROUBLESHOOTING §24**.

### Étape 4 — `<VocalSettings />` (6 états)
Apparaît à deux endroits — l'extraction supprime une duplication au passage.
Devient trivial si l'étape 3 est faite d'abord, puisqu'une des deux occurrences
disparaît.
**Gain : ~70 lignes. Risque : faible.**

### Étape 5 — `<AdvancedSettings />` (22 états)
Le plus gros gain. Bloc contigu à partir de la ligne 2674, n'influence la
génération qu'au moment de construire les paramètres.
→ Passer un objet unique `advancedParams` + `onChange` plutôt que 22 props.
**Gain : ~600 lignes. Risque : moyen (beaucoup de champs à vérifier).**

### Étape 6 — `<AudioPanel />` (17 + 9 états)
Emplacement audio, menu de mode, upload, glisser-déposer. Nettement plus simple
à extraire depuis la refonte : un seul emplacement au lieu de deux, et
`AUDIO_MODES` / `AUDIO_MODE_MAP` sont déjà au niveau module, prêts à déménager
avec le composant.
**Gain : ~250 lignes. Risque : moyen — le glisser-déposer touche `window`.**

### Étape 7 — `<LmSettings />` (25 états)
À faire en dernier : interagit avec OpenRouter, Pollinations et le pré-vol LLM
avant génération. Le plus couplé au reste.
**Gain : ~400 lignes. Risque : élevé.**

**Après ces étapes** : `CreatePanel.tsx` passerait d'environ 4 074 à
**1 200 lignes**, avec une quinzaine d'états au lieu de 126.

---

## Méthode par étape

À chaque extraction, la même séquence :

1. `git commit` de l'état courant (filet de sécurité)
2. Créer `app/components/create/<Nom>.tsx` avec ses états et son JSX
3. Dans `CreatePanel`, remplacer le bloc par `<Nom ... />` et supprimer les
   états déplacés
4. `npx vite build` — les erreurs TypeScript listent exactement ce qui manquait,
   c'est le meilleur guide
5. Tester le comportement dans l'UI
6. `git commit` avec un message décrivant l'étape

Ne jamais enchaîner deux étapes sans tester : si quelque chose casse, on veut
savoir laquelle.

**Vérification bon marché avant `vite build`** — un contrôle de syntaxe seul,
qui ne dépend pas de `node_modules` :

```bash
npx tsc --jsx preserve --noEmit --skipLibCheck --target es2020 \
  app/components/CreatePanel.tsx 2>&1 | grep -cE 'error TS1[0-9]{3}'
```

Doit afficher `0`. Les erreurs `TS2307` (module introuvable) et `TS7xxx`
(types implicites) sont attendues hors contexte de build complet.

---

## Ce qu'il ne faut PAS faire

**Une réécriture complète.** 4 074 lignes contiennent des années de détails —
gestion du pré-vol OpenRouter, files d'attente de génération, compatibilité avec
les paramètres JSON importés. Une réécriture en perdrait la moitié
silencieusement.

**Un state manager (Redux, Zustand) d'emblée.** Le problème n'est pas la nature
du state mais sa concentration. Découper d'abord ; si le passage de props
devient pénible ensuite, un contexte React suffira probablement.

**Toucher à la logique pendant l'extraction.** Déplacer du code et le corriger
en même temps rend impossible de savoir quelle modification a cassé quoi.
Extraire d'abord, corriger ensuite, dans deux commits séparés.

**Masquer un contrôle sans neutraliser sa valeur.** Un curseur caché dont la
valeur part quand même dans la charge utile rend le réglage inatteignable sans le
rendre inoffensif (TROUBLESHOOTING §23). Lors d'une extraction, si un champ passe
dans un sous-composant conditionnel, vérifier ce que devient sa valeur quand le
composant n'est pas rendu.

**Oublier la restauration de paramètres.** Plusieurs états sont réhydratés
depuis un morceau réutilisé (~l. 740-790) et depuis les réglages serveur
(~l. 490-540). Une extraction qui déplace un état sans déplacer sa réhydratation
produit un bug silencieux, visible seulement en réutilisant d'anciens
paramètres — c'est exactement ce qui aurait réintroduit le bug de l'instruction
(TROUBLESHOOTING §15).
