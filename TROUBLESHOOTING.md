# TROUBLESHOOTING — ACE-Step Studio (portage Linux)

Problèmes rencontrés lors du portage sous Linux Mint 22 (Ubuntu 24.04),
RTX 5060 8 Go, PyTorch 2.10.0+cu128, Python 3.12.3.

Le dépôt amont (`timoncool/ACE-Step-Studio`) ne fournit que des scripts
Windows (`.bat`). Les problèmes ci-dessous sont propres au portage ou à la
configuration matérielle, et chacun a demandé un temps de diagnostic
disproportionné par rapport à la simplicité du correctif.

---

## 1. `Could not load libtorchcodec` — la génération produit le son mais aucun fichier

**Symptôme.** La génération va jusqu'au bout (VAE décodé, audio normalisé),
puis échoue à l'écriture :

```
[AudioSaver] MP3 export failed without fallback: Could not load libtorchcodec
...
libtorchcodec_core6.so: undefined symbol:
  nppiNV12ToRGB_8u_ColorTwist32f_P2C3R_Ctx, version libnppicc.so.12
```

**Fausses pistes.** Le message d'erreur oriente vers FFmpeg ou vers une
incompatibilité torch/torchcodec. Les deux sont hors de cause : `install.sh`
installe un couple apparié (torch 2.10.0+cu128 / torchcodec 0.10.0+cu128), et
FFmpeg 6 du système est bien détecté. Sur les cinq tentatives de chargement
(core4 à core8), quatre échouent sur un `libavutil` absent — c'est normal, ce
sont les versions de FFmpeg non installées. **Seule compte l'erreur de la
version réellement présente**, ici core6.

**Cause réelle.** torchcodec lie `libnppicc` (NVIDIA Performance Primitives)
mais ne le déclare pas comme dépendance ; PyTorch ne l'installe pas non plus
car il ne s'en sert pas. Le chargement retombe alors sur le NPP du système —
`libnppicc.so.12.0.1.104`, soit CUDA 12.0 — trop ancien pour un build cu128.

Ironie : ce symbole sert à la conversion couleur vidéo NV12→RGB, sans aucun
usage pour de l'audio.

**Correctif.**

```bash
source .venv/bin/activate
uv pip install nvidia-npp-cu12
python -c "import torchcodec; print('OK')"
```

⚠️ Dans `install.sh`, ce paquet doit être installé dans un appel **séparé**,
sans `--index-url` : cette option *remplace* PyPI au lieu de s'y ajouter, et
`nvidia-npp-cu12` n'existe pas sur l'index PyTorch.

**Piège associé — `LD_LIBRARY_PATH`.** Le `run.sh` d'origine contenait :

```bash
export LD_LIBRARY_PATH="$SCRIPT_DIR/.venv/lib:$LD_LIBRARY_PATH"
```

Ce dossier ne contient aucun `.so` (juste `python3.12/`), mais le placer en
tête de la liste de recherche modifie l'ordre de résolution et fait passer le
NPP système devant celui de `site-packages/nvidia/`. **Supprimer cette ligne
suffisait à réparer le chargement.** Ne pas la remettre.

**Contournement si le NPP reste indisponible.** Seule l'écriture du fichier
échoue : `soundfile` (WAV/FLAC) et le binaire `ffmpeg` (MP3) remplacent
`torchaudio.save()` sans dépendance CUDA. Voir `audio_fallback.py`.
Noter que dans les torchaudio récents, `torchaudio.save()` délègue **tout** à
torchcodec — changer de format de sortie ne contourne donc rien.

---

## 2. Le modèle de langue se charge malgré `ACESTEP_INIT_LLM=false`

**Cause.** Deux variables coexistent :

| variable | lue par | effet |
|---|---|---|
| `INIT_LLM` | serveur Express | construit `--init_llm` dans la ligne de commande du pipeline |
| `ACESTEP_INIT_LLM` | moteur Python | ne sert qu'en lancement direct (`--gradio-only`) |

En passant par Express, seule `INIT_LLM` compte. Le `.env` du moteur définit
`ACESTEP_INIT_LLM=auto`, sans effet ici.

**Piège d'ordre.** `run.sh` charge `ACE-Step-1.5/.env` avec `set -a`. Toute
variable exportée **avant** ce bloc est écrasée. Les options de ligne de
commande doivent être appliquées **après**.

**Vérification.** Le log de démarrage montre la ligne de commande réelle :

```
[Pipeline] Starting: ... --init_llm false --enable-api ...
```

Utiliser `./run.sh --no-lm`, qui exporte les deux variables au bon moment.

---

## 3. `CUDA out of memory` à l'entraînement LoRA (carte 8 Go)

**Symptôme.** L'entraînement échoue pour quelques mégaoctets manquants :

```
Tried to allocate 24.00 MiB. GPU 0 has a total capacity of 7.52 GiB
of which 29.81 MiB is free. This process has 7.05 GiB memory in use.
```

**Diagnostic.** Réduire le rang LoRA de 64 à 32 ne libère que ~70 Mo : ce
n'est donc pas l'adaptateur qui remplit la VRAM, mais **le DiT résident du
serveur Gradio** (~6,8 Go alloués avant même le début de l'entraînement).

**Correctif.** Arrêter le pipeline pendant l'entraînement. C'est ce que fait
la case « Libérer la VRAM » de l'onglet Entraînement (`freeVram`, activée par
défaut) via `pipelineManager.stopForTraining()`. En ligne de commande, il
suffit d'arrêter `run.sh` avant de lancer `train.py`.

Résultat : pic VRAM à 5,4 Go sur 7,5 — large marge.

**Deux pièges dans `pipeline-manager.ts`** rencontrés en implémentant ceci :

1. Le handler `on('exit')` relance automatiquement le pipeline sauf si
   `isShuttingDown`. Un arrêt volontaire pour l'entraînement doit poser son
   propre drapeau (`isStoppedForTraining`), sinon le pipeline revient en 1 s
   et reprend la VRAM.
2. `killProcess()` programme un `SIGKILL` différé de 5 s sur `this.process`.
   Si un redémarrage a eu lieu entre-temps, ce SIGKILL tue le **nouveau**
   processus. Capturer la référence dans une variable locale.

**Autres leviers mémoire** (CLI Side-Step) : `--optimizer-type adamw8bit`,
`--offload-encoder`, `--gradient-checkpointing`, `--rank 16`.

---

## 4. Le CLI d'entraînement (Side-Step)

`ACE-Step-1.5/train.py` est en réalité **Side-Step v2.0.0**
(`github.com/koda-dernet/Side-Step`), intégré au moteur. Trois sous-commandes :

- `vanilla` — reproduit l'entraînement historique, décrit comme *bugged* dans
  l'aide, conservé pour compatibilité. **C'est celui qu'utilise l'UI Gradio.**
- `fixed` — version corrigée (timesteps continus + dropout CFG). Meilleure,
  et disponible uniquement en ligne de commande.
- `estimate` — analyse de sensibilité des gradients, sans entraînement.

**Piège 1 — ordre des arguments.** `--yes` et `--plain` sont des options
**globales** : elles précèdent le sous-commande.

```bash
python train.py --yes --plain fixed --checkpoint-dir ...   # correct
python train.py fixed --yes --plain --checkpoint-dir ...   # rejeté
```

**Piège 2 — `--log-every` est indispensable.** En mode `--plain`, l'affichage
Rich est désactivé : plus de barre de progression, plus de ligne VRAM, et
**aucune ligne d'époque** si `--log-every` n'est pas fourni. Sans lui, une UI
qui parse la sortie reste figée à 0 %.

`--plain` s'active aussi automatiquement quand stdout n'est pas un TTY —
c'est-à-dire systématiquement quand le processus est lancé depuis Express.

**Format parsable** (deux lignes par époque, mêmes valeurs) :

```
Epoch 1/20, Step 1, Loss: 0.9480
[OK] Epoch 1/20 in 2.9s, Loss: 0.9480
```

**Piège 3 — tout part sur stderr.** Bannière, configuration, progression,
erreurs : seules deux lignes sortent sur stdout. Un `spawn()` doit capturer
les deux flux, avec `stdio: ['ignore', 'pipe', 'pipe']` explicite.

**Bug d'affichage connu.** Le récapitulatif final indique « Epochs 0 / N »
alors que les N steps ont bien eu lieu et que les checkpoints portent les bons
numéros. Cosmétique.

---

## 5. Sauvegarde et étiquetage de dataset : Gradio obligatoire

**Symptôme.** Depuis l'UI React : `Erreur: 500: Not Found` à l'enregistrement
du dataset.

**Cause immédiate.** La route `/save-dataset` appelle
`POST {apiUrl}/v1/dataset/save`. Cet endpoint **n'existe pas**. L'API REST
d'ACE-Step 1.5 se limite à la génération — le log de démarrage l'énumère :

```
[Gradio] API endpoints enabled: /health, /v1/models, /release_task,
         /query_result, /create_random_sample, /format_lyrics
```

FastAPI renvoie un 404 `{"detail":"Not Found"}`, que le code transforme en 500.

**Cause de fond.** Le problème n'est pas l'URL. Les trois opérations dataset —
`save_dataset`, `preprocess_dataset`, `auto_label` — prennent toutes
`builder_state` en argument : l'objet `DatasetBuilder` vivant **dans la
session Gradio**. Le serveur Express dialogue avec Gradio via une session
distincte et ne peut pas le fournir. Aucune de ces fonctions n'expose
d'`api_name`, certaines sont même des `lambda`.

**Conséquence pratique.** Préparer un dataset se fait dans l'UI Gradio
(`./run.sh --gradio-only`, port 8001) : scan du dossier, auto-étiquetage,
sauvegarde. Le JSON sur disque contient alors `labeled: true`, et le
prétraitement puis l'entraînement fonctionnent depuis l'UI React.

**Vérifier ce qui est réellement sur le disque** (l'UI peut afficher
« Labeled 3/3 » alors que le fichier n'a rien enregistré) :

```bash
cd ACE-Step-1.5
../.venv/bin/python -c "
import json
d = json.load(open('./datasets/my_lora_dataset.json'))
for s in d.get('samples', []):
    print(s.get('filename'), '| labeled:', s.get('labeled'))
"
```

---

## 6. Objets `gr.update()` affichés bruts dans l'UI

**Symptôme.** Des champs contiennent littéralement `{"__type__":"update"}`, et
le compteur d'échantillons affiche 0 malgré un dataset chargé.

**Cause.** Gradio renvoie soit une valeur, soit un objet `gr.update()`
signifiant « ne change rien ». Les routes de `training.ts` recopient
`data[i]` tel quel ; côté React, `safeString()` finit par les sérialiser.

Le même objet en `data[1]` (dataframe) fausse le comptage :

```ts
sampleCount: Array.isArray((data[1] as any)?.data) ? (data[1] as any).data.length : 0
```

→ pas de `.data` sur un `gr.update()` → **0 échantillon**, d'où « Loaded 0
samples » puis « Éditer l'échantillon (1/0) ».

**Correctif.** Déballer côté serveur avant de renvoyer au front. Voir
`app/server/src/services/gradio-value.ts` (`gv()`, `dataframeRowCount()`).

---

## 7. Deux dossiers `datasets`

`install.sh` créait `datasets/` **à la racine** du Studio, alors que `run.sh`
exporte `DATASETS_DIR="$SCRIPT_DIR/ACE-Step-1.5/datasets"` et que le moteur
résout ses chemins relatifs depuis `ACE-Step-1.5/`. Résultat : deux dossiers
homonymes et des « fichier introuvable » incompréhensibles.

**Règle.** Tout ce qui concerne les datasets et les sorties LoRA vit sous
`ACE-Step-1.5/`. Corrigé dans `install.sh`.

---

## 8. Réflexes de développement

**Modification d'un fichier serveur** (`app/server/src/`) → **redémarrer
`run.sh`**. `tsx` charge les modules au démarrage et les garde en mémoire ;
une correction non redémarrée n'a aucun effet. Plusieurs heures ont été
perdues à déboguer du code qui n'était pas celui qui tournait.

**Modification d'un fichier front** (`app/components/`, `app/services/`) →
`npx vite build` puis rechargement du navigateur (Ctrl+Shift+R).

**Port déjà occupé.** Express bascule silencieusement sur 3002 si 3001 est
pris (`[Server] Port 3001 busy, trying 3002...`), ce qui peut faire coexister
deux instances — l'une avec l'ancien code. Vérifier :

```bash
ss -ltnp | grep -E "3001|3002|8001"
pkill -f "tsx.*app/server/src/index.ts"
pkill -f "acestep_v15_pipeline"
```

**Diagnostic d'un `spawn` silencieux.** Vérifier d'abord que le processus
existe vraiment, plutôt que de supposer :

```bash
ps aux | grep "train.py" | grep -v grep
nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv
```

**Attendre `[Pipeline] Ready!`** avant toute action dans l'UI. Un clic
prématuré donne `Connection errored out`, traduit en `500: Failed to start
training` — message trompeur qui n'a rien à voir avec la cause.

---

## 9. Scripts amont à ne pas exécuter tels quels

`ACE-Step-1.5/start_gradio_ui.sh` et `start_api_server.sh` contiennent une
fonction `_ensure_legacy_nvidia_torch_compat()` qui, si elle détecte un GPU
Pascal, **réinstalle de force torch 2.5.1+cu121** par-dessus l'installation
existante. Ils font aussi `uv sync` et proposent un `git pull` automatique.

Sur une installation portée manuellement, cela peut tout casser. Neutraliser
avec `ACESTEP_SKIP_LEGACY_TORCH_FIX=true` ou ne pas les utiliser.

---

## 10. Qualité des LoRA — attentes réalistes

Avec **un seul échantillon**, la loss oscille sans tendance (0,53 → 0,82 →
0,57 → 0,72) : le modèle voit la même donnée à chaque époque et le bruit du
timestep tiré aléatoirement domine. Le LoRA mémorise le morceau au lieu
d'apprendre un style, et la génération sonne étrangement — c'est attendu.

Pour un adaptateur utilisable :

- **15 à 30 morceaux** cohérents (même style, instrumentation, couleur) —
  c'est de loin le facteur le plus déterminant
- **30 à 50 époques** plutôt que 100+, en comparant les checkpoints
  intermédiaires : celui de l'époque 20 est souvent meilleur que le final
- **rang 16, alpha 32** sur un petit jeu de données ; un rang élevé donne au
  modèle la capacité de mémoriser

Attention aussi à `--max-duration` (240 s par défaut) : les morceaux plus
longs sont tronqués silencieusement.

---

## 11. Son dégradé après changement de modèle — DCW

**Symptôme.** Audio saturé, écrêté, sans dynamique. Dans les logs, `Peak=1.0000`
systématiquement avant normalisation.

**Cause.** La correction DCW s'applique à *chaque* pas de diffusion. Le réglage
par défaut (`mode=double`, `scaler=0.05`, `high_scaler=0.02`, `wavelet=haar`)
est calibré pour `acestep-v15-xl-turbo-bf16`, qui tourne en 8 steps. Avec
`acestep-v15-base` et ses 50 steps, la correction s'applique six fois plus
souvent et la dérive devient audible.

**Solution.** Désactiver DCW dès que le nombre de steps dépasse ~20, ou réduire
fortement le scaler (0,01 au lieu de 0,05) et repasser en mode `single`.
`Peak` doit alors retomber autour de 0,87.

**Constat général.** L'auto-ajustement des paramètres au changement de modèle
(`app/components/CreatePanel.tsx`, ~l. 684-711) ne couvre pas DCW. Un réglage
calibré pour turbo reste en place après une bascule vers `base` et dégrade la
sortie sans avertissement.

---

## 12. Mode Simple — charge utile parallèle et divergente

**Symptôme.** DCW reste actif en mode Simple alors que l'interrupteur est
visuellement désactivé.

**Cause.** `CreatePanel.tsx` construit **deux charges utiles distinctes**
(`onGenerate(effectiveCustomMode ? {...} : {...})`, ~l. 1620 et 1753). Le bloc
Simple omet entièrement les cinq champs DCW. Côté serveur,
`app/server/src/services/acestep.ts` applique alors sa valeur par défaut :

```ts
dcw_enabled: params.dcwEnabled ?? true,
```

Champ absent → DCW actif, quel que soit l'état de l'interrupteur, qui n'existe
que dans les réglages avancés du mode Personnalisé.

**Règle.** Tout champ ajouté à la charge utile du mode Personnalisé doit être
examiné pour le mode Simple. Le bloc Simple fixe aussi `inferenceSteps: 12` et
`guidanceScale: 9.0` en dur — valeurs calibrées pour le modèle turbo, mal
adaptées à `acestep-v15-base`.

---

## 13. Instrumental — le drapeau est ignoré par le moteur

**Symptôme.** Le morceau contient du chant malgré l'interrupteur « Instrumental »
activé, et malgré « Langue du chant : Auto / Instrumental » et « Genre de la
voix : Auto ».

**Cause.** Le drapeau `instrumental` est bien transmis dans la charge utile,
mais le moteur ne l'interprète pas : **seul le contenu du champ paroles compte**.
En mode Simple, `lyrics: ''` partait avec `instrumental: true` — le moteur
générait donc des paroles librement.

**Solution.** Forcer le marqueur que le moteur reconnaît, dans les deux charges
utiles :

```tsx
const finalLyrics = instrumental ? '[Instrumental]' : effLyrics;
const finalStyle  = instrumental ? effStyle : styleWithGender;
```

Neutraliser aussi `styleWithGender` : l'indice `Male vocals` / `Female vocals`
injecté dans le style pousse le modèle vers du chant même en instrumental.

---

## 14. Glisser-déposer — `dragstart` et `e.target` selon le navigateur

**Symptôme.** Un garde du type `e.target.closest('[data-no-drag]')` dans
`onDragStart` n'a aucun effet sous Firefox, alors que le code est correct.

**Cause.** Firefox émet `dragstart` sur l'élément **glissable** (celui qui porte
`draggable`), pas sur le nœud réellement sous le curseur. `e.target` est donc la
racine de la carte, au-dessus du conteneur marqué — `closest()` remonte et ne
trouve jamais le marqueur. Chrome, lui, cible le nœud profond.

**Solution.** Mémoriser la cible au `mousedown` (où `e.target` est correct) dans
une ref, et tester les deux dans `onDragStart` :

```tsx
const noDragRef = useRef(false);
// sur l'élément glissable :
onMouseDownCapture={(e) => {
  noDragRef.current = Boolean((e.target as HTMLElement).closest('[data-no-drag]'));
}}
// dans onDragStart :
if (noDragRef.current || (e.target as HTMLElement).closest('[data-no-drag]')) {
  e.preventDefault();
  return;
}
```

**Diagnostic.** Coller dans la console du navigateur :

```js
document.addEventListener('dragstart', e => { console.log('DRAGSTART', e.target, '| no-drag:', !!e.target.closest?.('[data-no-drag]'), '| types:', [...e.dataTransfer.types]); }, true);
```

Voir `app/components/SongList.tsx` (~l. 574-590).

---

## 15. Cover — l'instruction du DiT n'était jamais celle prévue

**Symptôme.** Les générations Cover produisent des artefacts massifs. Il faut
descendre la Force de reprise à 0 pour obtenir de la musique — c'est-à-dire
neutraliser le cover lui-même.

**Cause.** `app/server/src/services/acestep.ts` (~l. 186) prévoit une instruction
différente selon la tâche :

```ts
instruction_display_gen: params.instruction || (
  taskType === 'cover'   ? 'Generate audio semantic tokens based on the given conditions:' :
  taskType === 'repaint' ? 'Repaint the mask area based on the given conditions:' :
                           'Fill the audio semantic mask based on the given conditions:'
),
```

Mais `CreatePanel.tsx` initialisait l'état avec la valeur du text2music codée en
dur :

```ts
const [instruction, setInstruction] = useState('Fill the audio semantic mask based on the given conditions:');
```

Jamais vide, donc `params.instruction ||` court-circuitait systématiquement. Les
branches cover et repaint étaient du **code mort**. Le DiT recevait des latents
source *plus* l'instruction du text2music — deux conditionnements contradictoires.

**Solution.** Défaut à `''`, instruction effective affichée en `placeholder` via
`defaultInstructionFor(taskType)`. Une valeur persistée égale à l'ancien défaut
(`LEGACY_INSTRUCTION_DEFAULT`) est traitée comme vide, sinon chaque « réutiliser
les paramètres » réintroduit le bug.

**Diagnostic.** Dans les logs du moteur, la ligne `# Instruction` doit afficher
`Generate audio semantic tokens...` pour un cover :

```
# Instruction
Generate audio semantic tokens based on the given conditions:
```

Si elle affiche encore `Fill the audio semantic mask...`, une valeur persiste dans
les réglages sauvegardés — vider le champ à la main dans les avancés.

---

## 16. Artefacts résiduels en cover — « Nouvelle prise » à variance maximale

**Symptôme.** Après le correctif §15, il reste environ la moitié des artefacts, et
aucun réglage de cover ne les fait disparaître.

**Cause.** Le retake (`retakeVariance` / `retakeSeed`) était actif à variance 1,00
avec une graine à `-1` : un tirage de bruit indépendant, à intensité maximale,
mélangé à chaque génération. Le réglage traînait activé depuis des essais
antérieurs, restauré par les réglages sauvegardés.

Mesures à graine de génération fixe, même source, même caption :

| Force de reprise | Platitude spectrale (prise ON) | (prise OFF) | Énergie > 5 kHz vs source |
|---|---|---|---|
| 25 % | 0,1684 | **0,1550** | +0,0 % → −6,5 % |
| 50 % | 0,1840 | **0,1626** | +22,8 % → −0,7 % |
| 75 % | 0,1697 | **0,1633** | +3,6 % → +1,0 % |

Éteindre la prise ramène les trois rendus au niveau spectral de la source.

**Solution.** Interrupteur d'activation explicite (`retakeEnabled`), panneau replié
quand il est éteint, variance initialisée à 0,50 à l'activation, avertissement
au-delà de 0,70.

**Constat annexe.** La Force de reprise (`audioCoverStrength`) est quasi inerte
entre 0 et 75 % : enveloppe 0,903 / 0,897 / 0,897, chroma 0,933 / 0,943 / 0,946.
Elle ne contrôle **pas** la ressemblance à la source, contrairement à ce
qu'annonçait son libellé d'origine.

---

## 17. La graine de génération — quatre pièges

**Symptôme.** Deux générations aux réglages identiques donnent des résultats
radicalement différents, alors que la graine semble fixée.

**Piège 1 — deux panneaux nommés « graine ».** `retakeSeed` (variation sur une
prise) et `seed` (génération) se ressemblent et se suivent dans les avancés.
Renommés « Graine de la variation » et « Graine de génération », et réordonnés
pour que la seconde précède la première.

**Piège 2 — `-1` vaut « aléatoire ».** Éteindre l'interrupteur sans saisir de
nombre ne fixe rien : le moteur interprète `-1` comme un tirage. La bascule tire
désormais une graine réelle, un bouton permet d'en repiocher une, et un
avertissement s'affiche si la valeur retombe à `-1` ou `0`.

**Piège 3 — génération multiple.** `CreatePanel.tsx` (~l. 1759) :

```ts
randomSeed: randomSeed || i > 0,
```

Seule la première variante suit la graine ; les suivantes repassent en aléatoire.
Comportement inchangé, mais signalé quand `bulkCount > 1`.

**Piège 4 — graine de variation à `-1`.** Même avec la graine de génération fixée,
une prise active à `-1` réintroduit de l'aléatoire. Avertissement ajouté.

---

## 18. `t()` renvoie la clé — tous les replis i18n étaient morts

**Symptôme.** Des libellés bruts apparaissent dans l'interface : `generationSeed`,
`hintRetake`, au lieu du texte prévu.

**Cause.** `I18nContext.tsx` implémente la cascade
`translations[language][key] || translations.en[key] || key`. Le motif employé
partout dans `CreatePanel.tsx` :

```ts
t('maClé') || 'repli'
```

reçoit donc toujours une chaîne non vide à gauche, et **n'applique jamais le
repli**. Le bug était latent sur les 98 sites du fichier, invisible tant que les
clés existaient.

**Solution.** Helper local, et conversion mécanique des 98 sites :

```ts
const tf = useCallback((key: string, fallback: string): string => {
  const value = t(key);
  return !value || value === key ? fallback : value;
}, [t]);
```

**À faire.** Ajouter les clés dans `I18nContext.tsx` — les replis sont en français
en dur, donc l'anglais affiche du français sur ces libellés : `audio`, `remix`,
`modification`, `soon`, `coverNoiseStrength`, `hintCoverNoiseStrength`,
`hintInstructionEmpty`, `generationSeed`, `rerollSeed`, `warnSeedMinusOne`,
`warnSeedBulk`, `hintRetake`, `warnRetakeVariance`, `warnRetakeSeedRandom`.

---

## 19. Quel moteur tourne réellement

**Piège de lecture de code.**
`.venv/lib/python3.12/site-packages/diffusers/pipelines/ace_step/pipeline_ace_step.py`
existe, se laisse lire, et contient bien un pipeline ACE-Step — **mais ce n'est pas
lui qui s'exécute**. Les logs viennent de `acestep.core.generation.handler.*` et
`acestep.inference`, c'est-à-dire du paquet `acestep` de `ACE-Step-1.5/`.

Une analyse entière du chemin de conditionnement a été menée sur le mauvais fichier
avant que les noms de modules du log ne le révèlent.

**Réflexe.** Avant toute analyse de pipeline, lire les noms de modules dans le log
pour identifier le code réellement chargé. Le point d'entrée utile est
`ACE-Step-1.5/acestep/core/generation/handler/generate_music_request.py`,
fonction `_prepare_reference_and_source_audio`.

---

## 20. `reference_audio` et `src_audio` sont indépendants — `audio2audio` n'existe pas

**Constat.** `acestep.ts` (~l. 159-160) prépare les deux audios et les transmet
tous deux dans le même payload, sans exclusion mutuelle. Côté pipeline,
`refer_audio_acoustic` et `src_latents` sont deux canaux de conditionnement
distincts. Un mode combinant les deux est donc réalisable sans toucher au backend.

**Mais** `audio2audio` n'existe pas côté moteur :

```ts
// acestep.ts ~l. 170
const taskType = (params.taskType === 'audio2audio' ? 'cover' : params.taskType) || 'text2music';
// acestep.ts ~l. 625
if ((params.taskType === 'cover' || params.taskType === 'audio2audio') && !params.sourceAudioUrl && !params.audioCodes) { ... }
```

Réécrit en `cover`, puis rejeté faute de source. Un mode « référence seule » doit
donc envoyer `taskType: 'text2music'` avec l'URL dans `referenceAudioUrl` — accepté
tel quel par `generate.ts` (~l. 423). Validé à l'écoute : le morceau est bien
coloré par la référence.

**Note.** Une référence instrumentale ne force pas une sortie instrumentale : ce
sont le champ paroles et le drapeau `instrumental` qui décident (voir §13).

---

## 21. Paramètres morts — motif récurrent

Un champ accepté et défaulté par le serveur, qu'aucun état du frontend n'alimente.
Il passe inaperçu parce que le défaut est silencieux.

- `coverNoiseStrength` — `params.coverNoiseStrength ?? 0.0` côté serveur, aucun
  état côté UI, donc toujours 0. Câblé depuis.
- `no_fsq` — codé en dur à `false` dans `acestep.ts`, alors que le moteur connaît
  `cover-nofsq`. Toujours inatteignable depuis l'interface.
- `isUploadingSource` — état jamais positionné, corrigé antérieurement.
- `instruction` — cas inverse : un état *toujours* rempli qui neutralisait la
  logique serveur (§15).

**Réflexe.** Avant d'ajouter un curseur, vérifier dans `acestep.ts` que le
paramètre n'existe pas déjà, orphelin. Et symétriquement (voir §12), tout champ
ajouté à une charge utile doit être examiné pour l'autre.

---

## 22. Méthode — tester un paramètre de génération

**Sans graine fixe, on mesure le hasard.** Deux générations aux réglages identiques
se sont écartées davantage l'une de l'autre (corrélation d'enveloppe 0,86) que
25 % et 75 % de Force de reprise ne s'écartaient entre elles. Plusieurs conclusions
intermédiaires ont été invalidées pour cette seule raison.

**Conditions d'un test contrôlé.**

1. Graine de génération fixée sur un **nombre réel**, pas `-1`.
2. Nombre de variantes à **1**.
3. « Nouvelle prise » **éteinte**.
4. Un seul paramètre modifié entre les rendus.

Ces conditions réunies, les rendus corrèlent entre eux à 0,977–0,996 : la graine
gouverne tout, et l'effet du paramètre devient lisible.

**Métriques utiles**, calculées par FFT sur un mono 16 kHz (fenêtre 2048, saut
512) :

- *Corrélation d'enveloppe* — log de l'énergie par trame. Suit la structure :
  montées, creux, arrangement. Survit à un changement d'orchestration.
- *Chroma image par image* — similarité cosinus sur 12 classes de hauteur, bande
  80–4000 Hz. Suit l'harmonie. C'est la bonne mesure de « même morceau ».
- *Énergie au-dessus de 5 kHz* et *platitude spectrale* — détectent les artefacts.
  À comparer **à la source**, pas dans l'absolu.

**À éviter.** La corrélation de forme d'onde brute. Deux rendus du même morceau
décalés de quelques millisecondes tombent à 0,10 et donnent l'illusion qu'ils
n'ont rien en commun — erreur commise et corrigée pendant cette session.

**Limite.** Les métriques spectrales et l'oreille divergent parfois : sur une série,
le rendu jugé le meilleur à l'écoute était celui qui mesurait le plus d'excès de
haute fréquence. L'oreille reste l'arbitre.

---

## 23. `cover_noise_strength` — un paramètre masqué mais toujours envoyé

**Symptôme.** En mode Inspiration, le rendu n'est plus de la musique mais du
bruit. Aucun réglage visible du panneau AUDIO ne permet de le corriger : il faut
basculer en mode Cover pour atteindre un curseur qui, lui, agit bien sur
l'Inspiration.

**Mesures** (référence de 120 s, comparée à la source) :

| | Platitude spectrale | Énergie > 5 kHz | Enveloppe vs source |
|---|---|---|---|
| source | 0,166 | 0,032 | — |
| Inspiration, bruit à 0,20 | **0,454** | **0,116** | **−0,067** |
| Cover propre, bruit à 0,20 | 0,175 | 0,031 | 0,900 |

Une platitude de 0,45 est proche du bruit blanc ; une corrélation d'enveloppe de
−0,07 signifie qu'il ne reste aucun lien avec l'audio de référence.

**Cause.** Deux erreurs combinées, introduites en exposant le paramètre mort
`coverNoiseStrength` (voir §21) :

1. Son défaut est passé de 0 à 0,20 — alors qu'il valait 0 depuis toujours,
   faute d'état côté frontend.
2. Le curseur a été masqué hors du mode source, sur l'hypothèse **non vérifiée**
   que `cover_noise_strength` ne s'appliquait qu'à la branche `src_audio`.

Or `acestep.ts` transmet le champ **quel que soit le mode** :

```ts
cover_noise_strength: params.coverNoiseStrength ?? 0.0,
```

Masquer le curseur cachait donc la valeur sans la neutraliser. Le paramètre agit
en réalité sur les deux branches, mais avec des effets opposés : progressif et
utile côté `src_audio`, destructeur côté `reference_audio`. Le libellé
« Fidélité » ne vaut que pour le Cover.

**Solution.** Défaut ramené à 0, seule valeur sûre dans tous les modes. Les deux
curseurs (Reprise et Fidélité) affichés en permanence. En mode Inspiration, le
pourcentage passe en rouge dès qu'il dépasse 0, avec une aide dédiée.

**Règle générale.** *Ne jamais masquer un contrôle dont la valeur continue d'être
envoyée.* Soit le champ est neutralisé dans la charge utile en même temps qu'il
est masqué, soit le contrôle reste visible. Un curseur invisible dont la valeur
part quand même est pire qu'un curseur inutile : il rend le réglage
inatteignable sans le rendre inoffensif.

**Corollaire méthodologique.** Le commentaire justifiant le masquage était une
déduction de lecture de code, pas une mesure — et il a été traité comme acquis.
Voir §22 : un test contrôlé aurait coûté trois générations.

---

## 24. Suppression du mode Simple — trois pièges au passage

**Contexte.** Les modes Simple et Personnalisé construisaient des charges utiles
divergentes (§12), source de plusieurs bugs. Le mode Simple a été supprimé, la
description « Décrivez votre chanson » remontée dans le panneau unifié.

**Piège 1 — la requête part en 400 sans que rien ne le dise.**
`generate.ts` (~l. 423) exige `style` OU `lyrics` OU un audio de référence. La
description n'entre pas dans cette validation : elle doit d'abord être
développée par le pré-vol OpenRouter. Une description seule produisait
`400: Style, lyrics, or reference audio required for custom mode`, visible
uniquement dans la console du navigateur.

**Piège 2 — le déclenchement du pré-vol.** Le garde d'origine était
`!customMode && useOpenRouter && !activeLmModel`. Deux erreurs :

- `!activeLmModel` supposait qu'un LM local pouvait prendre le relais. Il sait
  écrire des paroles mais **pas de style**, donc il ne satisfait jamais la
  validation à lui seul.
- Une première correction exigeait style ET paroles vides, ce qui laissait le
  cas « style écrit + paroles vides » sans aucun rédacteur.

Règle retenue : le pré-vol se déclenche dès que **les paroles** sont vides et
qu'une description existe.

```ts
const preflightWillRun =
  useOpenRouter && Boolean(songDescription.trim()) && !lyrics.trim();
```

**Piège 3 — l'échec du pré-vol était fatal.** Une clé OpenRouter refusée
(`401 User not found`) faisait tomber toute la génération, alors qu'un style
saisi suffisait à produire un morceau. Le pré-vol est désormais facultatif quand
la charge utile tient debout sans lui :

```ts
const payloadValidWithoutDraft =
  Boolean(style.trim() || lyrics.trim() || referenceAudioUrl.trim() || sourceAudioUrl.trim());
```

**Défaut connexe corrigé.** `effStyle` et `effLyrics` plaçaient le brouillon du
LLM **avant** le champ saisi par l'utilisateur : un style écrit à la main était
écrasé. L'ordre est désormais champ → brouillon → ref.

**Règle générale.** Un `return` muet dans un gestionnaire de clic donne un
bouton mort. Soit le bouton est désactivé avec la raison affichée, soit l'action
part. Jamais un clic sans effet ni explication.

---

## 25. Video Studio — accumulation mémoire et mort par OOM

**Symptôme.** L'écran se fige complètement, curseur compris, pendant un rendu
vidéo. Reboot obligatoire. Aucune erreur applicative.

**Diagnostic.**

```bash
journalctl -k -b -1 | grep -i "out of memory\|oom-kill"
```

```
Out of memory: Killed process (python) anon-rss:13893236kB
cinnamon invoked oom-killer
```

13,9 Go de RSS sur une machine de 16 Go — le bureau lui-même manquait de
mémoire. Le `total-vm` à 77 Go est de la réservation virtuelle CUDA, sans
rapport.

**Cause.** `VideoGeneratorModal.tsx` accumulait **toutes** les images en base64
avant le premier envoi :

```ts
const frameData = canvas.toDataURL('image/jpeg', 0.85);
capturedFrames.push(frameData.split(',')[1]);   // libéré seulement à la fin
```

Une image 1080p JPEG q0.85 pèse ~250 ko, ~340 ko en base64, et JavaScript stocke
les chaînes en **UTF-16** : ~680 ko de RAM par image. Un rendu de 8 000 images
demande donc **~5,4 Go** pour le seul tableau, auxquels s'ajoutent le canvas,
l'`AudioBuffer` décodé et le `JSON.stringify` de chaque lot.

**Solution.** Ouvrir la session avant la boucle et téléverser chaque lot dès
qu'il est complet. Détail important : détacher le tableau **avant** l'`await`,
pour que le ramasse-miettes puisse travailler pendant la requête.

```ts
const flushFrames = async () => {
  const chunk = pendingFrames;
  pendingFrames = [];        // AVANT l'await
  await fetch('/api/render-video/frames', { ... });
};
```

Empreinte ramenée de ~5,4 Go à ~35 Mo. Mesuré : 8 042 images encodées sans
incident.

**Correctifs serveur associés** (`render-video.ts`) :

- `createReadStream(...).pipe(res)` au lieu de `readFile` + `res.send`, qui
  chargeaient le MP4 entier en RAM puis en faisaient une copie. Nettoyage du
  dossier déplacé sur l'événement `close` de la réponse.
- `frames[i] = ''` après écriture, pour libérer au fil de la boucle.
- Repli sur `libx264` si NVENC échoue : `hasNvenc()` ne vérifie que la présence
  de l'encodeur dans le binaire, pas que le GPU puisse l'allouer avec le modèle
  ACE-Step chargé.

**Réglage système.** Le swap était à 2 Go pour des pics à 14 Go. Porté à 16 Go,
avec `vm.swappiness=10` (défaut 60, trop empressé à swapper avec un
déchargement CPU permanent).

---

## 26. Video Studio — fond vidéo noir (CSP)

**Symptôme.** Les fonds image fonctionnent, les fonds vidéo restent noirs — en
prévisualisation comme dans le MP4 exporté. Vaut pour les vidéos Pexels **et**
pour un MP4 importé localement. Signalé aussi en amont (issue #17, Windows/Chrome).

**Cause.** Le bloc `helmet` de `app/server/src/index.ts` définissait `imgSrc`
avec `blob:` — commenté en détail pour la prévisualisation des pochettes — mais
**pas de `mediaSrc`**. Sans cette directive, le navigateur retombe sur
`defaultSrc: ["'self'"]`, qui exclut `blob:`. Or un MP4 importé passe par
`URL.createObjectURL(file)`, donc une URL `blob:`.

```
Content-Security-Policy : media-src bloqué à l'adresse blob:http://localhost:3001/...
car elle enfreint la directive : « default-src 'self' »
```

**Solution.** Dans le bloc helmet, après `imgSrc` :

```ts
mediaSrc: ["'self'", 'data:', 'blob:', 'https:', 'http://localhost:*'],
```

Redémarrer le serveur (`tsx` ne recharge pas à chaud) puis **Ctrl+Maj+R** :
Firefox met les en-têtes CSP en cache. Vérification sans passer par l'UI :

```bash
curl -sI http://localhost:3001/ | grep -i content-security-policy
```

**Attention aux CSP multiples.** Le fichier en définit trois — helmet pour
l'application, plus deux `res.setHeader` pour `/editor` et `/demucs-web`. Quand
plusieurs politiques s'appliquent, le navigateur retient **l'intersection** : la
plus restrictive gagne toujours. Les deux dernières contenaient déjà `media-src`
avec `blob:`, ce qui donnait l'illusion que le besoin était couvert.

**Ce que ça ne règle pas.** Les vidéos Pexels butent sur CORS, pas sur la CSP.
Les images passent parce que `picsum.photos` renvoie les en-têtes ; le CDN vidéo
non. Retirer `crossOrigin='anonymous'` serait un faux correctif : la vidéo
s'afficherait mais le canvas deviendrait *tainted* et `toDataURL` lèverait une
`SecurityError` à la capture. Il faut un proxy serveur. **Non implémenté.**

**Défauts connexes corrigés** dans `VideoGeneratorModal.tsx` :

- Le repli sur image n'existait pas malgré le commentaire :
  `bgImageRef.current = null` dès que le type passait à « video ». Un échec
  vidéo ne laissait donc que le `fillRect` noir.
- `crossOrigin` n'est plus posé sur les URL `blob:` et `data:`, où il n'a
  aucun sens.
- Un bandeau ambre signale l'échec dans l'UI, au lieu d'un `console.warn`.

---

## 27. Video Studio — le téléchargement audio et la fausse panne

**Symptôme.** Le rendu reste bloqué à 2 % indéfiniment. Aucune requête audio
visible dans l'onglet Réseau.

**Deux causes successives, à ne pas confondre.**

**a) URL vide.** `song.audioUrl` était `undefined` sur certains objets — le
champ existe aussi en `audio_url` selon la provenance. `fetch('')` vise la page
courante et **ne rejette jamais** : l'interface gelait sans le moindre message.
Le même fichier utilisait trois graphies différentes à trois endroits.

```ts
const resolveAudioUrl = (song: any): string =>
  (song?.audioUrl || song?.audio_url || song?.audio || '').trim();
```

**b) Délai inadapté.** Une fois l'URL résolue, un premier correctif imposait
60 s de plafond — et échouait sur des FLAC de 48 Mo parfaitement sains.

Pourquoi la bibliothèque ne souffre pas du même problème : le lecteur **diffuse
en flux** et démarre après quelques centaines de ko. L'export appelle
`decodeAudioData`, qui exige le fichier **complet**. Les deux chemins n'ont rien
à voir — d'où l'illusion trompeuse que « le morceau se lit bien, donc l'URL est
bonne ».

**Solution.** Un délai sur l'**absence de données** plutôt que sur la durée
totale : chaque morceau reçu repousse l'échéance. Un transfert lent mais vivant
n'est plus interrompu ; une vraie coupure est détectée en 120 s. Lecture par
morceaux avec `Content-Length` pour afficher une progression réelle.

**Note.** Aucune route ne sert de version compressée : `audioFormat` est un
choix fait à la génération. Les FLAC de 40-60 Mo doivent donc être téléchargés
entiers pour l'export vidéo.

**Progression figée — cause distincte.** `setTimeout(0)` programme une
macrotâche, entre lesquelles le navigateur *peut* peindre sans y être obligé si
la file est saturée. Avec ~50-100 ms de canvas par image, le rendu écran était
affamé. Remplacé par une cession sur `requestAnimationFrame`, toutes les 10
images au lieu de 30. `analyzeAudioOffline`, déclarée `async` sans le moindre
`await`, bloquait aussi le fil principal de bout en bout.

**Reste ouvert.** Une vidéo de fond courte est mise en boucle par
repositionnement de l'élément `<video>` à chaque image — 8 000 `currentTime`
avec une attente jusqu'à 50 ms chacune. Fonctionne, mais ralentit la capture.

---

## 28. Séparation de pistes (Demucs Web) — dépendances distantes et gel mémoire

**Contexte.** Video Studio possède déjà une séparation de pistes fonctionnant
entièrement dans le navigateur via ONNX Runtime Web (`app/server/public/demucs-web/`),
accessible depuis le menu d'un morceau (« Extraire les pistes (Stems) ») ou
directement sur `/demucs-web/?audioUrl=…`. Elle fonctionnait, mais dépendait de
trois ressources distantes à chaque session — donc inutilisable hors connexion,
et coûteuse en réseau à chaque ouverture de page.

---

### 28.1 — Le modèle était retéléchargé à chaque session (172 Mo)

**Symptôme.** Chaque ouverture de la page de séparation retélécharge
`htdemucs_embedded.onnx` (~172 Mo) depuis Hugging Face, alors qu'`app.js`
contenait déjà une constante `LOCAL_MODEL_URL` pointant vers un fichier local.

**Cause.** La logique de chargement essayait le distant **en premier**, le local
en repli — l'inverse de ce qu'on veut pour une application locale :

```js
// avant
try {
  await processor.loadModel(DEFAULT_MODEL_URL);   // distant, ~172 Mo
} catch {
  await processor.loadModel(LOCAL_MODEL_URL);     // local, jamais atteint
}
```

Et le fichier local référencé par `LOCAL_MODEL_URL = '../models/htdemucs_embedded.onnx'`
n'existait pas sur le disque.

**Solution.**

1. Télécharger le modèle une fois dans `app/server/public/models/htdemucs_embedded.onnx`
   (voir `fetch-assets.sh`, §28.5).
2. Inverser l'ordre : local d'abord, distant en repli si le fichier local est absent.
3. **Servir `/models` avant le catch-all SPA.** Sans montage explicite,
   `express` renvoyait `index.html` avec un statut **200** pour toute URL
   inconnue — le fetch réussissait, mais `InferenceSession.create` échouait
   ensuite sur du HTML avec un message de bas niveau sans rapport
   (`protobuf parsing failed`), qui a fait perdre un temps considérable à
   chercher une corruption de fichier inexistante :

```ts
// index.ts — DOIT précéder le catch-all SPA
app.use('/models', express.static(path.join(__dirname, '../public/models')));
```

**Diagnostic pour la prochaine fois.** Avant de suspecter le fichier, vérifier
ce que le serveur sert réellement :

```bash
curl -sI http://localhost:3001/models/htdemucs_embedded.onnx | grep -i content-type
```

`application/octet-stream` = bon. `text/html` = le catch-all répond à la
place du fichier statique, quel que soit le code retourné par `curl` (souvent
200, ce qui trompe une vérification rapide qui ne regarde que le statut).

---

### 28.2 — Le runtime ONNX venait encore d'un CDN

**Symptôme.** Une fois le modèle local en place, la séparation échoue toujours
hors connexion.

**Cause.** `app.js` importe le runtime ONNX Runtime Web directement depuis
jsdelivr :

```js
import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/ort.all.mjs';
```

Ce runtime charge lui-même dynamiquement ses fichiers `.wasm` (calcul réel)
depuis la même origine que le script importé.

**Solution.** Rapatrier le runtime en local (`npm pack onnxruntime-web@1.21.0`,
voir `fetch-assets.sh`), importer le fichier local, et surtout fixer le chemin
de résolution des `.wasm` en **absolu** :

```js
import * as ort from '/vendor/onnxruntime/ort.all.min.mjs';

// ABSOLU impératif : un chemin relatif est résolu depuis l'emplacement de
// ort.all.min.mjs lui-même (déjà /vendor/onnxruntime/), pas depuis la page —
// un chemin du type '../vendor/onnxruntime/' produit un /vendor/vendor/
// silencieusement erroné.
ort.env.wasm.wasmPaths = '/vendor/onnxruntime/';
```

Piège de vérification : un test de repli volontaire vers le CDN a révélé que
`wasmPaths` était bien appliqué — l'URL en échec devenait
`https://cdn.jsdelivr.net/vendor/onnxruntime/...`, confirmant le mécanisme —
ce qui a permis d'écarter une fausse piste (suspicion sur `ort.all.min.mjs`
lui-même) avant de trouver la vraie cause en 28.3.

Ne garder que les fichiers nécessaires à l'exécution WASM pure (pas de WebGPU
disponible sur toutes les machines) : `ort.all.min.mjs`,
`ort-wasm-simd-threaded.{wasm,mjs}`, `ort-wasm-simd-threaded.jsep.{wasm,mjs}`.
Les variantes WebGL/WebGPU/Node du paquet npm (~150 Mo à elles seules) sont
inutiles ici.

---

### 28.3 — Blocages intermittents malgré des fichiers locaux corrects

**Symptôme.** Modèle et runtime tous deux servis localement, avec les bons
types MIME, et pourtant le chargement échoue de façon **intermittente** :
dans l'onglet Réseau, des requêtes identiques vers
`ort-wasm-simd-threaded.jsep.mjs` alternent entre succès (304) et
`NS_ERROR_BLOCKED_BY_POLICY`, sans schéma apparent.

**Fausse piste explorée.** Le nombre de threads (12, un par cœur) a été
suspecté — le runtime crée onze workers qui rechargent le même module en
rafale, ce qui ressemble à une course. Réduire `ort.env.wasm.numThreads` à 4
n'a rien changé : ce n'était pas la cause.

**Cause réelle.** L'isolement cross-origin (nécessaire à `SharedArrayBuffer`
et donc au multithreading WASM) exige **deux** en-têtes simultanés sur
**chaque sous-ressource** de la page, pas seulement le document HTML :

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Le montage `/demucs-web` posait bien les deux sur les fichiers qu'il sert.
Mais `/models` et `/vendor` — ajoutés après coup, montés séparément — n'en
avaient **aucun**. Firefox active `crossOriginIsolated = true` de façon
optimiste au chargement de la page, puis rejette silencieusement, requête par
requête, toute sous-ressource dépourvue de `COEP` : d'où le mélange
succès/échec sur une URL identique, qui n'a rien à voir avec de la
concurrence.

**Diagnostic.** `crossOriginIsolated` dans la console renvoie `true` même
quand le problème est présent — ne pas s'y fier seul. Le tell est dans
l'onglet Réseau → en-têtes de réponse d'une requête vers `/models/…` ou
`/vendor/…` : `Cross-Origin-Embedder-Policy` y est absent alors qu'il est
présent sur les requêtes vers `/demucs-web/…`.

**Solution.** Poser les deux en-têtes sur `/models` et `/vendor` également :

```ts
app.use('/models', (req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  next();
}, express.static(path.join(__dirname, '../public/models')));

app.use('/vendor', (req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  next();
}, express.static(path.join(__dirname, '../public/vendor')));
```

**Règle générale.** Sur une page dépendant de l'isolement cross-origin, tout
nouveau montage statique qui lui sert des ressources doit reproduire les deux
en-têtes — ils ne s'héritent pas d'un préfixe de route à un autre.

---

### 28.4 — Gel de l'interface pendant l'extraction (contention mémoire)

**Symptôme.** Une fois 28.1-28.3 résolus, l'extraction aboutit mais Firefox
propose parfois d'arrêter la page pendant le traitement.

**Diagnostic.**

```bash
watch -n 2 free -h
```

Mesuré pendant une extraction avec ACE-Step chargé en parallèle : **13 Go
utilisés sur 15,9 Go, 515 Mo libres, 1,7 Go de swap sollicité**. `--no-lm`
(désactivation du seul LM local) ne change presque rien à ce chiffre — le
poids vient du DiT et du déchargement CPU permanent d'ACE-Step (voir §25),
pas du modèle de langage.

**Cause.** Deux moteurs d'inférence lourds coexistent sur une machine à
16 Go : ACE-Step (DiT + déchargement CPU) et l'inférence WASM de Demucs
(~180 Mo de protobuf décodé, poids et graphe alloués en mémoire de travail).
Sous cette pression, le système swappe, et un swap actif ralentit
suffisamment le rendu de la page pour déclencher l'avertissement "page ne
répond pas" de Firefox — ce n'est pas un blocage logique, la page continue de
progresser en arrière-plan.

**Contournement actuel (manuel).** Décharger le pipeline ACE-Step (bouton
existant dans l'onglet Modèles) avant de lancer une séparation. Sans ACE-Step
chargé, l'extraction dispose d'une marge confortable.

**Solution propre — non implémentée.** Le même motif que l'entraînement LoRA
(§3) : deux tâches qui ne peuvent pas cohabiter sur une machine à VRAM/RAM
limitée. Généraliser le mécanisme de déchargement déjà utilisé par
l'entraînement pour qu'il se déclenche aussi avant une séparation de pistes,
plutôt que de dupliquer la logique une troisième fois pour la conversion MIDI
à venir.

---

### 28.5 — `fetch-assets.sh`

Script de rapatriement pour les deux ressources ci-dessus, à lancer une fois
après un clone du dépôt. Les dossiers cibles sont dans `.gitignore` — ~210 Mo
au total, hors dépôt :

```bash
./fetch-assets.sh
```

Idempotent : vérifie la taille des fichiers déjà présents avant de
retélécharger quoi que ce soit. La taille du modèle Demucs est vérifiée au
bit près (`Content-Length` confirmé) ; celle des fichiers du runtime ONNX
seulement approximativement, npm n'exposant que des tailles arrondies.

**À faire si le dépôt gagne un jour un mécanisme d'installation
automatisé** : appeler ce script depuis `run.sh` ou l'équivalent, pour que
l'étape ne soit plus manuelle.

---

### 28.6 — `pytorch_wavelets` sous Python 3.12 (DCW)

Note indépendante, sans lien avec la séparation de pistes, mais rencontrée le
même jour et concernant le même profil d'environnement.

**Symptôme.** `pytorch_wavelets` échoue à charger ses coefficients de filtre
(`coeffs.py`) sous Python 3.12, la faute à `pkg_resources`, retiré de
`setuptools` récent.

**Solution**, dans
`.venv/lib/python3.12/site-packages/pytorch_wavelets/dtcwt/coeffs.py` :

```python
# avant
from pkg_resources import resource_stream

# après — 2 lignes, rend le paquet independant de pkg_resources/setuptools
import importlib.resources as resources

def resource_stream(package, resource):
    return resources.files(package).joinpath(resource).open("rb")
```

**Portée.** Modification appliquée directement dans l'environnement virtuel :
ne survit pas à une reconstruction du `.venv`. À documenter dans le script
d'installation si le DCW (§11) doit rester utilisable sous Python 3.12 sans
intervention manuelle répétée.

---

### 28.7 — Piste explorée et abandonnée : déchargement automatique avant séparation

**Objectif initial.** Généraliser le contournement manuel de 28.4 (décharger
ACE-Step avant une séparation de pistes) en appel automatique depuis
`demucs-web`, sur le modèle de ce qui existe pour l'entraînement LoRA.

**Ce qu'on a découvert en creusant.** Il n'existe pas de mécanisme de
déchargement réutilisable côté moteur.

- `unload_models(*models)` (`acestep/training_v2/model_loader.py:376`) est
  générique et fonctionne bien, mais n'est appelée que dans le chemin
  d'entraînement (`estimate.py`, `preprocess.py`) — jamais depuis le serveur
  API de génération.
- La route `/v1/init` (`acestep/api/http/model_service_routes.py`) ne connaît
  qu'un seul mode : charger/remplacer un modèle. `InitModelRequest` n'a aucun
  champ permettant « décharge et ne recharge rien ».
- `initialize_service()`, qui fait le travail réel
  (`acestep/core/generation/handler/init_service_orchestrator.py:48`),
  déclare explicitement dans sa docstring qu'**elle ne décharge jamais
  l'ancien modèle avant de charger le nouveau** :

  > *"it does not short-circuit when components are already loaded"*

  Chaque changement de modèle (y compris depuis `ModelMenu.tsx`) charge donc
  le nouveau par-dessus l'ancien, en comptant sur le ramasse-miettes Python et
  un éventuel `torch.cuda.empty_cache()` en aval pour récupérer la mémoire —
  sans garantie de timing. Cause plausible, non confirmée, de pics mémoire
  observés ailleurs dans cette session.

**Pourquoi on s'est arrêté là.** Ajouter un vrai `/v1/unload` demanderait de
modifier `initialize_service` — ou d'écrire une fonction sœur qui connaît tous
les attributs qu'elle peuple (`self.dit`, `self.vae`, LM, tokenizer, cache…)
sans filet de tests pour vérifier qu'aucun n'est oublié. C'est une
modification du cœur du chargement de modèle d'ACE-Step, pas un ajout
d'endpoint isolé — hors de portée d'une session, et pas le genre de risque à
prendre sans tests dédiés.

**Contournement retenu.** Décharger manuellement via l'onglet Modèles avant
une séparation de pistes (voir 28.4). Zéro risque, un clic.

**Pour qui reprend ce chantier.** Le point d'entrée logique est
`InitServiceOrchestratorMixin.initialize_service` — regarder la suite de la
méthode (au-delà de la ligne 140) pour inventorier tous les attributs qu'elle
peuple, avant d'écrire une méthode `unload()` sœur qui les libère tous via
`unload_models(*[...])`. Traiter ça comme une modification du moteur ACE-Step
en amont, avec ses propres tests, pas comme un patch du portage Studio.

---

## 29. Playlists vs Espaces de travail — séparation, et bugs qui en ont découlé

**Contexte.** Une fonctionnalité « Espaces de travail » a été construite par
petites étapes sur plusieurs sessions : d'abord réutilisant entièrement les
données de Playlist (deux onglets, mêmes données — délibéré à l'époque, pour
avancer vite), puis séparée réellement une fois le partage jugé gênant en
pratique (« créer un espace se répercute sur playlist et vice versa »).

### 29.1 — Séparation par colonne `kind`, pas par table séparée

Décision retenue après discussion : ajouter une colonne `kind` (`'playlist'`
par défaut, ou `'workspace'`) sur la table `playlists` existante, plutôt que
créer une table dédiée. Réutilise toute l'infrastructure déjà en place
(création, ajout de chanson, suppression), pas de duplication.

**Piège découvert en préparant la migration** : ce projet utilise
**SQLite** via `better-sqlite3` (confirmé dans `db/pool.ts`), pas
PostgreSQL — malgré une syntaxe de requêtes (`$1, $2`, `RETURNING *`) qui y
ressemble fortement. Une première migration écrite en SQL PostgreSQL
(`ALTER TABLE ... ADD CONSTRAINT`) aurait échoué : SQLite ne supporte pas
l'ajout de contrainte `CHECK` après coup sans reconstruire toute la table.
Solution : script Node.js (`run-migration-kind.mjs`) utilisant directement
`better-sqlite3`, la même bibliothèque que le serveur — élimine tout risque
d'incompatibilité de version entre un `sqlite3` système et le binaire
embarqué. Sauvegarde automatique du fichier avant modification, vérification
d'idempotence (colonne déjà présente = ne rien refaire).

**Piège Express** : toute nouvelle route de préfixe fixe (`GET
/workspace-song-ids`) doit être déclarée **avant** `GET /:id` dans le
routeur, sinon Express interprète le préfixe comme une valeur de `:id` et la
route n'est jamais atteinte.

### 29.2 — « Mon espace de travail » : virtuel, pas une ligne en base

Deux options envisagées pour le fil d'Ariane par défaut : une vraie ligne
créée à l'installation (avec migration pour les comptes existants, logique
d'attribution automatique à chaque génération, protection contre le
renommage/suppression), ou une vue calculée par exclusion. La seconde a été
retenue — plus simple, aucune migration supplémentaire, et explique
naturellement pourquoi cette vue n'est ni renommable ni supprimable :
elle n'existe pas en tant qu'entité.

**Implémentation** : `GET /api/playlists/workspace-song-ids` renvoie l'union
des identifiants de chansons appartenant à *n'importe quel* espace nommé
d'un utilisateur (une seule requête SQL, pas N appels). Côté client, la vue
par défaut affiche toutes les chansons **sauf** celles présentes dans cette
union. Rafraîchi à quatre moments : chargement initial, ajout d'une chanson
à un espace, retrait d'une chanson, suppression d'un espace entier — chacun
de ces cas change potentiellement l'ensemble d'exclusion, et un oubli aurait
laissé une chanson invisible ou visible à tort jusqu'au prochain
rechargement complet (motif déjà rencontré plusieurs fois, voir §29.3).

### 29.3 — État périmé après suppression de playlist

**Symptôme.** Suppression d'une playlist réussie côté serveur, mais sa
carte reste visible et cliquable dans la grille. Cliquer dessus tente de
rouvrir un identifiant qui n'existe plus → 404 (« Playlist not found »).
Seul un rechargement complet (Ctrl+Maj+R) purge l'entrée fantôme.

**Cause.** `PlaylistDetail.tsx` appelait bien l'API de suppression, mais ne
prévenait jamais le composant parent (`App.tsx`) — son état local
`playlists` n'était donc jamais mis à jour.

**Correctif.** Callback `onPlaylistDeleted`, appelé après succès de
l'appel API, qui retire la ligne de l'état local. Même motif appliqué à
`onSongRemovedFromPlaylist` (retrait d'une chanson) pour la même raison —
sans lui, une chanson retirée d'un espace resterait exclue à tort de « Mon
espace de travail » (voir §29.2) jusqu'à rechargement.

**Leçon générale** : toute action qui modifie une relation chanson↔espace
côté serveur doit avoir un chemin de retour explicite vers l'état du
composant parent qui affiche des vues dérivées de cette relation. Un
`console.error` silencieux en cas d'échec ne suffit pas non plus — voir
§29.4 pour un cas où l'absence totale de callback avait rendu une action
entièrement muette, sans la moindre erreur.

### 29.4 — Actions du menu déroulant silencieuses depuis la Bibliothèque

**Symptôme.** « Reprendre la chanson (Cover) » et « Utiliser comme
référence » ne faisaient rien du tout, sans erreur console, quand
déclenchées depuis l'onglet Bibliothèque — alors qu'elles fonctionnaient
(avec un bug différent, voir §29.5) depuis l'onglet Créer.

**Cause.** `LibraryView.tsx` affiche `SongDropdownMenu` directement, sans
passer par `SongList`/`SongItem`. Trois callbacks (`onCoverSong`,
`onUseAsReference`, `onAddToWorkspace`) n'étaient tout simplement jamais
déclarés dans son interface de props ni transmis à ses deux instances
internes de `SongDropdownMenu` — ni erreur de compilation (props
optionnelles) ni erreur d'exécution (`handleAction(undefined)` se contente
de fermer le menu), juste un silence total.

**Correctif.** Les trois callbacks ajoutés à l'interface, à la
déstructuration, et transmis aux deux blocs `<SongDropdownMenu>`.

**Leçon générale** : quand un même menu contextuel (`SongDropdownMenu`)
est intégré à plusieurs endroits du code (`SongList`/`SongItem` d'un côté,
`LibraryView` de l'autre, sans partager de composant commun), toute
nouvelle action ajoutée doit être vérifiée aux **deux** points d'intégration
— sinon elle ne fonctionne que là où elle a été testée en premier.

### 29.5 — Cover/Reference : audio chargé, mais section pas affichée

**Symptôme.** Cliquer sur « Reprendre la chanson (Cover) » depuis
l'intérieur de l'onglet Créer (par exemple en filtrant sur un espace de
travail) chargeait bien l'audio, mais la section « Cover » ne s'affichait
jamais — l'interface restait sur le mode déjà actif.

**Cause.** `applyAudioTargetUrl` (CreatePanel.tsx) dérivait `taskType` du
mode **déjà actif** au moment du clic, pas de l'intention réelle de
l'action :
```ts
const mode = AUDIO_MODE_MAP[audioMode];  // mode COURANT, pas celui visé
setTaskType(mode.field === target ? mode.taskType : 'text2music');
```
Si tu étais sur Inspiration en cliquant Cover, `taskType` retombait sur
`text2music` : l'audio se chargeait dans le bon emplacement mais rien ne
disait à l'interface de changer de section pour le montrer. Sans erreur,
sans plantage — juste un état incohérent.

**Correctif.** `pendingAudioSelection` transporte désormais un `mode`
explicite (`AudioModeId`), fixé par l'appelant (`handleCoverSong` →
`'cover'`, `handleUseAsReference` → `'inspiration'`). `applyAudioTargetUrl`
bascule `audioMode` **avant** de calculer `taskType`, en lisant le
paramètre reçu plutôt que l'état React (asynchrone — le relire juste après
`setAudioMode()` aurait donné l'ancienne valeur, piège classique de
fermeture obsolète).

### 29.6 — Recherche qui plante : `.tags.some is not a function`

**Symptôme.** Taper le premier caractère dans la recherche, à l'intérieur
d'un espace de travail filtré, faisait planter tout le rendu de l'onglet
Créer (écran noir).

**Cause.** `song.tags.some(...)`, appelé sans protection dans le filtre de
recherche. Toutes les voies de construction d'objet chanson vérifiées
(`refreshSongsList` dans App.tsx, le mapping de `PlaylistDetail.tsx`)
fixent correctement `tags: s.tags || []` — la source exacte du morceau
fautif n'a **pas** été identifiée avec certitude cette session.

**Correctif.** Garde-fou défensif (`Array.isArray(song.tags) ? song.tags :
[]`), étendu par précaution à `title`/`style` (même risque de `.toLowerCase()`
sur `undefined`). Rend le plantage impossible sans avoir besoin de connaître
la cause exacte — mais celle-ci reste à élucider si elle se reproduit.

**Piège de plantage identique déjà rencontré** : voir la découverte de
`createdAt` en `snake_case` au lieu de `camelCase` dans `PlaylistDetail.tsx`
(§29.3-adjacent, session du 24/08) — même famille de bug (objet chanson
divergent de la forme canonique), cause différente cette fois.
Décoder la boucle une seule fois vers un tableau d'images serait la bonne
approche.
