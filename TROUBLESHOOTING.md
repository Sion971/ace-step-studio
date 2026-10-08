# TROUBLESHOOTING — ACE-Step Studio (portage Linux)

Problèmes rencontrés lors du portage sous Linux Mint 22 (Ubuntu 24.04),
RTX 5060 8 Go, PyTorch 2.10.0+cu128 à l'origine (aujourd'hui 2.11.0+cu128 ou
2.14.1+cu130 selon la pile choisie, voir §33), Python 3.12.3.

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

**Mise à jour (04/10).** Ce correctif était décrit ici, mais `gradio-value.ts`
n'existait **pas** dans le dépôt : `training.ts` recopiait toujours `data[i]` tel
quel (66 lectures brutes, dont le code fautif cité ci-dessus). Il est désormais
réellement appliqué : 65 lectures enveloppées dans `gv()`, comptage par
`dataframeRowCount()`. `gv()` rend la valeur d'une sortie, la *nouvelle* valeur d'un
`gr.update(value=…)`, ou `undefined` pour un `gr.update()` sans valeur (que
`JSON.stringify` omet) ; `0`, `''` et `false` restent des valeurs. Même défaut dans
une autre route ? Utiliser ce helper, pas un nouveau contournement.

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
relancer `run.sh` : il recompile l'interface quand une source est plus récente que
`app/dist`, puis recharger le navigateur (Ctrl+Shift+R). Avant, `app/dist` n'était
compilé que s'il manquait : un `git pull` laissait l'ancienne interface en place, et
les nouveautés n'apparaissaient pas (le serveur, lui, prenait bien le nouveau code).
Sans relancer : `cd app && npx vite build`.

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

---

## 30. Dataset copié d'une autre installation — chemins audio périmés

**Symptôme.** Après avoir copié `datasets/` d'une installation à une autre,
« Charger » échoue avec `500: Failed to load dataset`. Le log serveur, lui, dit :

```
gradio.exceptions.InvalidPathError: Cannot move
  /home/studio/ACE-Step-Studio-master/ACE-Step-1.5/datasets/uploads/my_lora_dataset/6. Le Cri du Retour.mp3
  to the gradio cache dir because it was not created by the application or it is not
  located in either the current working directory or your system's temp directory.
```

**Fausses pistes.** Ce n'est ni torch ni la version de CUDA. Et sur une installation
neuve, « Dataset not found » n'est pas un mauvais dossier : c'est le bon
(`ACE-Step-1.5/datasets/`), le fichier n'y existe simplement pas encore.

**Cause.** Le JSON d'un dataset enregistre des chemins audio **absolus**. Copié
ailleurs, il pointe vers l'ancienne installation. Gradio ne sert un fichier que s'il est
sous le dossier courant (`ACE-Step-1.5/`) ou le `temp` du projet : l'aperçu du premier
échantillon est refusé. Le script de prétraitement lirait les mêmes chemins.

**Correctif.** `healDatasetAudioPaths()` (`app/server/src/services/dataset-paths.ts`)
est appelée avant « Charger » et avant le prétraitement. Elle retrouve les fichiers
déplacés — même position relative sous `datasets/`, à défaut même nom sous
`uploads/<nom du dataset>/` — et corrige les chemins **dans le JSON**, en écrivant une
sauvegarde `<fichier>.bak-paths` une seule fois. Elle gère les chemins Windows
(`C:\…`) et les noms accentués ou avec apostrophe.

Garde-fous : seuls les JSON situés sous `datasets/` sont lus et écrits ; un chemin de
remplacement n'est accepté que sous ce dossier (un JSON importé ne peut pas faire
pointer l'aperçu ailleurs avec des `..`) ; un chemin sans correspondance est laissé
tel quel.

**Limite.** Elle *retrouve* des fichiers, elle n'en crée pas : les audios doivent être
présents dans la nouvelle installation.

```bash
cp -r ~/ancienne-installation/ACE-Step-1.5/datasets/uploads/<nom> \
      ~/nouvelle-installation/ACE-Step-1.5/datasets/uploads/
```

---

## 31. « Failed to … » — le vrai message d'erreur de Gradio était masqué

**Symptôme.** L'interface n'affiche qu'un texte générique (« Failed to load dataset »)
alors que le log serveur contient la cause exacte.

**Cause.** Le client Gradio lève un objet simple `{ type: 'status', message, … }`, pas
une `Error`. Dix-neuf blocs `catch` de `training.ts` faisaient
`error instanceof Error ? error.message : '<texte>'` : le test était faux, et le texte
générique masquait la cause.

**Correctif.** `gradioErrorMessage(error, fallback)` (`gradio-value.ts`) renvoie le
vrai message, tronqué à 600 caractères. À utiliser dans toute nouvelle route qui
appelle Gradio.

---

## 32. « Appliquer les paramètres » du dataset sans effet

**Symptôme.** Le bouton ne change rien : le JSON sauvegardé ne contient ni
l'étiquette d'activation, ni la position, ni le ratio de genre. Pour un LoRA, c'est
l'étiquette (`custom_tag`) qui manque au prétraitement.

**Cause.** La route `POST /api/training/update-settings` répondait
`{ success: true }` sans rien appeler. Son commentaire disait que les réglages étaient
« appliqués à la sauvegarde via l'API REST » : cet endpoint n'existe pas, et
`/save-dataset` ne lit que `savePath` et `datasetName`, même si le client lui envoie les
quatre réglages.

Côté ACE-Step, ces réglages vivent dans le `builder_state` de la **session Gradio**. Un
seul endroit les y inscrit : `update_settings(custom_tag, tag_position,
all_instrumental, genre_ratio)`. `save_dataset(save_path, dataset_name)` n'en reçoit
aucun et écrit l'état tel quel. L'interface native d'ACE-Step branche d'ailleurs
`update_settings` sur l'événement `.change` de chaque champ : elle n'a pas de bouton
« Appliquer ».

**Correctif.** La route appelle l'endpoint Gradio `/update_settings`, dans l'ordre de la
signature Python, après validation (`services/dataset-settings.ts`) :
`tag_position` ∈ `prepend | append | replace`, `genre_ratio` borné à 0–100, booléen
strict. Une valeur invalide donne un 400 explicite plutôt qu'un ratio converti en 0.

Vérifié de bout en bout : après « Appliquer » puis « Sauvegarder », le JSON contient
`custom_tag: 'mady'`, `tag_position: 'prepend'`, `all_instrumental: False`,
`genre_ratio: 45`.

```bash
# l'endpoint existe-t-il dans la session Gradio ? (serveur lancé)
curl -s http://127.0.0.1:8001/gradio_api/info | python3 -c \
  "import sys,json; print([k for k in json.load(sys.stdin)['named_endpoints'] if 'update_settings' in k])"
# attendu : ['/update_settings', '/update_settings_1', '/update_settings_2', '/update_settings_3']
```

**Limites d'ACE-Step.** Une étiquette vide est ignorée (on ne peut pas effacer une
étiquette déjà posée), et sans dataset chargé il n'y a rien à mettre à jour : le bouton
ne signale alors aucune erreur. `/save-dataset` ignore toujours les réglages que lui
envoie le client — il faut cliquer « Appliquer » avant « Sauvegarder ».

---

## 33. Piles CUDA — 13.0 par défaut, 12.8 et 12.6

**Le menu.** `install.sh` lit le GPU (`nvidia-smi`) et **suggère** une famille ; `Entrée` l'accepte.

| Famille | Pile | PyTorch | Pilote NVIDIA | flash-attn |
|---|---|---|---|---|
| RTX 20xx et plus récentes | **CUDA 13.0** (défaut si le pilote la permet) | 2.14.1 | **580 ou plus** | roue précompilée v0.10.0 (`cu130torch2.14`), testée sur le GPU |
| id., pilote plus ancien | CUDA 12.8 | 2.11.0 | 525 ou plus ; **570 ou plus** pour une RTX 50xx | roue v0.9.4 (Blackwell), sinon compilation |
| GTX 10xx (Pascal), Volta | CUDA 12.6 | 2.11.0 | 525 ou plus | SDPA (flash-attn exige une capacité de calcul ≥ 8.0) |

**Pourquoi 13.0 pour tout Turing et plus.** CUDA 13.x couvre toutes les cartes à partir de
Turing (NVIDIA a retiré Maxwell, Pascal et Volta en 13.0 : le seuil est la capacité de calcul
7.5, donc Volta, à 7.0, est exclue aussi). CUDA 13.0 est le défaut de PyTorch (PyPI : `cuda-toolkit`
13.0.x). PyTorch 2.14 est la dernière série à publier des roues CUDA 12.x (la 2.15 est
annoncée en CUDA 13.x seulement) : Pascal et Volta restent sur la pile 12.6 tant que la 2.14
est disponible.

**Planchers de pilote** (NVIDIA, « CUDA minor version compatibility ») : CUDA 13.x → pilote
**≥ 580** ; CUDA 12.x → **≥ 525** ; toute RTX 50xx → **≥ 570** (CUDA 12.8 : ≥ 570.26). Le
595.58.03 souvent cité est le pilote *livré avec* le toolkit CUDA 13.2 Update 1, pas le minimum
requis par une roue PyTorch, qui embarque son propre runtime. L'installateur contrôle le
plancher de la pile choisie avant de télécharger quoi que ce soit.

**L'en-tête de `nvidia-smi` a changé de libellé.** Les pilotes récents (série 615) n'affichent plus
`Driver Version` / `CUDA Version` mais `KMD Version` / `CUDA UMD Version` :
`| NVIDIA-SMI 615.71.09   KMD Version: 615.71.09   CUDA UMD Version: 13.4 |`. La première
détection cherchait `CUDA Version:` et ne trouvait rien : « pilote non détecté », pile 12.8
suggérée à tort, planchers et garde Blackwell ignorés. L'installateur accepte désormais les deux
libellés ; à défaut, il **déduit** la version CUDA du numéro de pilote (`nvidia-smi
--query-gpu=driver_version`, requête stable) avec la table des pilotes minimaux de NVIDIA, et le
dit dans son résumé. Un pilote plus récent que la table est classé « au moins 13.2 ».

**Symptôme — `torch.cuda.is_available()` vaut `False`.** Le pilote est plus ancien que la pile :
PyTorch ne voit pas le GPU. Mettre à jour le pilote, ou relancer `install.sh` et choisir la
pile CUDA 12.8.

**`cu118` a disparu.** Pour `cu118`, l'index PyTorch s'arrête à **torch 2.7.1** (vérifié :
`curl -s https://download.pytorch.org/whl/cu118/torch/`). L'ancienne option « Pascal » demandait
`torch==2.11.0` en `cu118` : elle ne pouvait pas s'installer. Elle utilise désormais `cu126`.
Plus généralement, l'installateur vérifie **avant de télécharger** que l'index propose
`torch <version>` pour la pile choisie, et s'arrête avec la dernière version disponible plutôt
que par un échec cryptique du résolveur pip.

**Pourquoi pas CUDA 13.2.** PyTorch l'a introduit comme build *expérimental* (2.12) et garde
13.0 comme défaut en 2.14 (les nightlies de la 2.15 passent 13.2 en stable). La roue
`flash-attn` `cu132torch2.14` existe, mais `torchaudio` (dernière version : 2.11.0) et
`torchcodec` en cu132 n'ont pas été vérifiés. À reconsidérer avec la 2.15.

**flash-attn : test fonctionnel.** Une roue précompilée qui ne contient pas l'architecture de la
carte s'importe sans erreur, puis échoue au premier vrai appel (`no kernel image is available`).
Après installation d'une roue précompilée, l'installateur lance un vrai `flash_attn_func` sur le
GPU ; en cas d'échec, `flash-attn` est retiré et SDPA prend le relais (sans compilation de
plusieurs heures). Ce test, plus que `cuobjdump` (absent de beaucoup de machines), décide si
la roue cu130 convient à une carte Ampere ou Ada.

**Avertissement inédit en 2.14 — `register_constant()`.** Au lancement, torchao 0.17
affiche que `register_constant()` sur les enums est « déprécié et sera une erreur dans
une future version ». Sans effet aujourd'hui. Le plafond `torchao<0.18.0` n'est **pas** à
lever pour le faire disparaître : torchao 0.18 supprime `AffineQuantizedTensor` et les
layouts v1, que le code d'ACE-Step nomme (message `model.to() raised NotImplementedError
(AffineQuantizedTensor…)`). Garder aussi `torch==2.14.1` exact.

**NPP (étape 5b).** Sautée sur la pile 13.0 : `nvidia-npp-cu12` n'y est pas installé. Vérifié
paquet désinstallé : `torchaudio.load()` d'un MP3 stéréo 48 kHz, puis `torchaudio.save()` en
WAV, FLAC et MP3 fonctionnent. Le §1 reste valable pour la pile cu128, où l'échec a été
diagnostiqué ; les piles cu126 et cu128 gardent l'étape par prudence.

**Validé sur RTX 5060 8 Go** (pile 13.0) : installation neuve, génération de 4 minutes,
chargement d'un LoRA, Cover, DCW. **Non validé** : l'entraînement complet sur cette pile ; les
piles 12.8 et 12.6 (non exercées depuis le changement de menu) ; une carte Ampere ou Ada sur la
pile 13.0 (la roue `flash-attn` y est testée à l'installation, mais pas encore sur ces cartes).

---

## 34. Profil matériel — modèle par défaut selon la VRAM

**Symptôme.** Sur une carte de 4 à 6 Go, le Studio échouait au premier lancement ou
ramait, et le modèle de langage restait activé alors qu'ACE-Step n'en propose aucun sous
6 Gio.

**Cause.** `run.sh` imposait `acestep-v15-xl-turbo-bf16` à tout le monde. Le Studio annonce
lui-même 8 Go minimum pour ce modèle (`vramMin` dans `utils/modelNames.ts`), et la doc
d'ACE-Step classe les modèles XL « non pris en charge » sous 12 Go (`GPU_COMPATIBILITY.md`).
Le serveur, lui, active le LM par défaut (`INIT_LLM`).

**Correctif.** `install.sh` lit le GPU 0 (`nvidia-smi` : nom, VRAM, capacité de calcul),
**suggère** la famille du menu (capacité de calcul ≥ 7.5 : RTX 20xx et plus ; sinon anciennes
cartes ; `Entrée` l'accepte, un choix explicite l'emporte), calcule le palier ACE-Step et écrit
`hardware_profile.env`, que `run.sh` lit.

Le palier reprend **les seuils exacts** de `acestep/gpu_config.py::get_gpu_tier`
(`≤4`, `≤6`, `≤8`, `≤12`, `<15,5`, `<20`, `≤24` Gio). Les seuils sont vérifiés contre cette
fonction, extraite de leur code, sur 1 158 valeurs de VRAM : aucun écart.

**Quelle mesure de VRAM ?** ACE-Step lit `torch.cuda.get_device_properties(0).total_memory`, plus
**petit** que le `memory.total` de `nvidia-smi` : sur une RTX 5060, 7,609 Gio contre 7,960
(8151 Mio), soit 0,351 Gio (4,4 %). L'installateur affiche d'abord le palier d'après `nvidia-smi`
(PyTorch n'est pas encore installé) ; en fin d'installation, le profil enregistre le palier calculé
d'après **la mesure de PyTorch**, c'est-à-dire celui que le moteur verra (`HW_VRAM_TORCH_MIB`), avec
`nvidia-smi` en repli. La **classe nominale** (8 Go pour une « 8 Go », qui choisit le modèle par
défaut) reste calculée d'après `nvidia-smi` : un écart de 4 % ne doit pas faire passer une carte de
8 Go sous le seuil de 8 Go du Studio.

| VRAM | Palier | Modèle DiT par défaut | Modèle de langage |
|---|---|---|---|
| ≤ 4 Gio | 1 | `acestep-v15-turbo` (2B) | désactivé |
| 4–6 Gio | 2 | `acestep-v15-turbo` (2B) | désactivé |
| 6–8 Gio | 3 | XL Turbo BF16 si la VRAM *nominale* est ≥ 8 Go, sinon `acestep-v15-turbo` | activé |
| ≥ 8 Gio | 4 et plus | `acestep-v15-xl-turbo-bf16` | activé |

La VRAM nominale est la valeur arrondie : une carte « 8 Go » mesure 7,96 Gio et reste
dans la classe 8. **Pour une carte de 8 Go ou plus, rien ne change** : seules les cartes
sous 8 Go reçoivent un autre défaut.

**Priorités.** Un `DEFAULT_MODEL` ou un `INIT_LLM` déjà défini dans l'environnement l'emporte,
puis `ACE-Step-1.5/.env`, puis le profil, puis l'ancien défaut. Sans `hardware_profile.env`
(installation existante), le comportement est strictement l'ancien. Le fichier est propre à
la machine (ignoré par git) : relancer `install.sh` pour le refaire.

**Sécurité.** Le profil est lu par `source` : le nom du GPU est restreint à un jeu de
caractères sûr (lettres, chiffres, espace, `._+()/-`), sinon un nom contenant `$(…)` s'exécuterait.

**Garde-fou Blackwell.** Une RTX 50xx exige un pilote 570 ou plus (CUDA 12.8 : ≥ 570.26) ;
la pile CUDA 13.0 demande 580 ou plus. Sous 570, aucune pile ne fonctionne : l'installateur le
dit avant d'installer et demande confirmation pour continuer (voir aussi les planchers du §33).

**Limites.**
- `LM_MODEL` et `LM_BACKEND` ne sont **pas** pilotés : le Studio les fixe à `0.6B` / `pt`, et
  `routes/generate.ts` les code en dur pour l'état affiché. La taille de LM recommandée par
  ACE-Step pour le palier est notée dans le profil (`HW_ACE_RECOMMENDED_LM`) à titre informatif.
- Pour les paliers 3 et 4, garder `xl-turbo-bf16` s'écarte du tableau amont (XL non pris en
  charge sous 12 Go) : c'est le choix du Studio, validé en pratique sur 8 Go.
- **Téléchargement des modèles.** Il se déclenche au premier lancement, dans ACE-Step
  (`initialize_service` : paquet principal, puis DiT demandé ; le LM seulement s'il est actif),
  pas dans `run.sh`. Le bouton de l'interface et `download_model.sh` ne gèrent que les modèles XL.
  Le profil règle donc ce qui est téléchargé : DiT par défaut, LM actif ou non. Composition
  **mesurée** du dépôt `ACE-Step/Ace-Step1.5` (tailles en Go décimaux, comme les affiche Hugging Face) :
  turbo 2B 4,79 Go, LM 1,7B 3,76 Go, encodeur de texte 1,20 Go, VAE 0,34 Go ; le LM 0,6B a son
  propre dépôt.

  Trois défauts du téléchargeur embarqué (`ACE-Step-1.5/acestep/model_downloader.py`, modifié au
  portage Linux), constatés en simulant le premier lancement avec le vrai code : (1) le DiT turbo
  2B n'était **jamais** téléchargé — le paquet principal l'exclut, et `ensure_dit_model` répondait
  « Main model is available » sans regarder les poids : le chargement échouait sur toute carte de
  moins de 8 Go ; (2) le LM 1,7B, inutilisé par le Studio, était téléchargé pour tout le monde ;
  (3) le paquet principal exigeait le LM 0,6B, absent de ce dépôt : jamais « complet » quand le LM
  est désactivé, donc un appel réseau à chaque lancement et un échec hors ligne. Corrigé : le
  paquet principal se réduit au VAE et à l'encodeur de texte ; le turbo 2B et le LM 1,7B se
  téléchargent à la demande (`download_main_subfolder`). Volume du premier lancement (en Go décimaux ; le profil, lui, raisonne en Gio de VRAM) :

  | Profil | Avant | Après |
  |---|---|---|
  | ≤ 6 Gio (turbo 2B, sans LM) | 5,3 Go, DiT absent : échec | ≈ 6,3 Go |
  | 6–8 Gio (turbo 2B, LM 0,6B) | 6,5 Go, DiT absent : échec | ≈ 7,5 Go |
  | ≥ 8 Gio (XL BF16, LM 0,6B) | ≈ 15,8 Go | ≈ 12,0 Go |

  Le LM 0,6B (≈ 1,2 Go) est une estimation (0,6 milliard de paramètres sur 2 octets) ; le XL BF16
  (9,3 Go) est la taille annoncée par le Studio. Validé par un vrai téléchargement du DiT 2B
  (6,3 Go mesurés : paquet principal en 14 fichiers sans turbo ni LM 1,7B, puis le turbo seul). Le chemin ModelScope, inchangé, télécharge le dépôt
  entier. Contournement manuel, si besoin :
  `hf download ACE-Step/Ace-Step1.5 --include "acestep-v15-turbo/*" --local-dir ACE-Step-1.5/checkpoints`.
- Logique simulée avec un `nvidia-smi` factice (18 cartes, parcours de menu, priorités de
  `run.sh`) ; non passée sur une machine réellement équipée d'une petite carte.

---

## 35. Mode processeur (option 3) — temps mesurés et délai de génération

**Mesures** (une seule machine : portable ASUS X570ZD, Ryzen, 14 Gio de RAM ; la carte GTX 1050 de 2 Gio
n'est pas utilisée ; DiT turbo 2B quantifié en int8, 8 pas, sans modèle de langage) :

| Durée demandée | Temps total | Diffusion | Décodage du VAE |
|---|---|---|---|
| 14 s | 3 min 40 s | 112 s (14 s par pas) | ≈ 78 s |
| 29 s | 6 min 41 s | 185 s (23 s par pas) | ≈ 180 s |

Soit environ 14 à 16 fois la durée de l'audio, avec environ 8,5 Go de mémoire résidente. Le démarrage prend
une minute lorsque les modèles sont déjà là. Ces chiffres ne se généralisent pas à d'autres processeurs.

**Symptôme — « NOT ENOUGH GPU MEMORY » sur une machine sans GPU.** ACE-Step coupe toute génération au bout de
`ACESTEP_GENERATION_TIMEOUT` secondes (600 par défaut) et son message de dépassement parle de VRAM (« … the GPU
ran out of VRAM or the diffusion loop stalled »). Le Studio testait le mot « VRAM » pour afficher
« NOT ENOUGH GPU MEMORY », donc un simple délai dépassé était présenté comme un manque de mémoire. Une première
génération de 30 s a été coupée après 9 min 30 s de diffusion ; le même extrait a ensuite pris 3 min de
diffusion. La cause de cette lenteur initiale est inconnue : c'est un argument pour une limite large plutôt
que serrée.

**Correctif.**
- `install.sh`, en option CPU, écrit `HW_MODE="cpu"` et `HW_GENERATION_TIMEOUT=3600` dans `hardware_profile.env` ;
  `run.sh` l'exporte vers `ACESTEP_GENERATION_TIMEOUT`, **sauf** si la variable est déjà définie (environnement
  ou `ACE-Step-1.5/.env`, qui l'emportent). Le bandeau indique « mode processeur » et le délai.
- Le Studio distingue désormais un délai dépassé d'un manque de mémoire (`services/generation-errors.ts`) et
  explique la marche à suivre.

**Installation existante en mode processeur** : relancer `./install.sh`, ou ajouter
`ACESTEP_GENERATION_TIMEOUT=3600` dans `ACE-Step-1.5/.env`, ou le poser avant `./run.sh`.

**Limites.** Une heure est une valeur générale : elle couvre les extraits courts mesurés, pas des durées de
plusieurs minutes, dont le temps croît plus vite que la durée de l'audio. À relever au besoin. Les autres
processeurs n'ont pas été mesurés.

**Un délai dépassé n'arrête pas le calcul.** ACE-Step le dit lui-même (« the CUDA operation may still be
running in the background ») : le calcul se poursuit après le message. Mesuré avec un délai forcé à 60 s : le
premier calcul, déclaré en échec à 21:02:25, s'est terminé à 21:03:45, alors que la demande suivante
tournait déjà depuis 21:03:17. Les deux se chevauchent. Après un délai dépassé, attendre la fin du premier
calcul avant d'en lancer un autre.

---

## 36. Cartes Pascal (GTX 10xx) — « Cannot set version_counter for inference tensor »

**Symptôme.** L'installation et le démarrage réussissent (« DiT model initialized successfully »,
« Pipeline Ready! »), puis la première génération échoue :

```
RuntimeError: Cannot set version_counter for inference tensor
  ... init_service_memory_transfer.py ... _move_module_recursive
  ... torchao/quantization/linear_activation_quantized_tensor.py ... _apply_fn_to_data
```

**Cause** (reproduite et confirmée sur une GTX 1050, `torch 2.11.0+cu126`, `torchao 0.17.0`). ACE-Step impose
la quantification `w8a8_dynamic` aux cartes dont la capacité de calcul majeure est inférieure à 7 (Pascal et
antérieures ; Turing et Volta prennent `int8_weight_only`). torchao enveloppe alors les poids dans un
`LinearActivationQuantizedTensor`, que `_is_quantized_tensor` ne reconnaissait pas : il ne connaissait que
`AffineQuantizedTensor`. Le déplacement du DiT vers le GPU se fait dans `torch.inference_mode()` (`service_generate`
est décorée `@torch.inference_mode()`) : ces poids prenaient la branche générique `param.data.to(device)`, qui
échoue. Le même code existe dans ACE-Step amont.

**Preuve** (`pascal_quant_move_test.py`, petit modèle de 4 blocs, code réel d'ACE-Step, GTX 1050) :

| Cas | Déplacement | Calcul sur le GPU |
|---|---|---|
| `int8_weight_only`, code tel quel (contrôle) | OK | OK (0,45 % d'écart) |
| sans quantification (contrôle) | OK | OK (0,08 %) |
| `w8a8_dynamic`, code tel quel | **échec** (l'erreur ci-dessus) | — |
| `w8a8_dynamic`, type reconnu comme quantifié | OK | OK (0,86 %) |
| `w8a8_dynamic`, déplacement hors mode inférence | OK | OK (0,86 %) |
| les deux ensemble | OK | OK (0,86 %) |

`w8a8_dynamic` calcule donc correctement sur Pascal : seul le déplacement échouait.

**Correctif.** `_is_quantized_tensor` reconnaît aussi `LinearActivationQuantizedTensor`, ce qui envoie ces poids
vers `_move_quantized_param` (`_apply_fn_to_data`), comme pour `int8_weight_only`. Des trois corrections qui
fonctionnent, c'est la plus petite : elle ne change que le déplacement de ce type de poids, dans le contexte
exact du vrai lancement. Tests : `init_service_quantized_move_test.py` (reconnaissance du type ; déplacement
processeur → GPU → processeur → GPU dans `torch.inference_mode()`, avec un calcul après chaque aller).

**Limites.** Le test de preuve utilise un petit modèle, pas le DiT complet : la GTX 1050 testée n'a que 2 Gio et
ne peut pas le charger (le budget d'ACE-Step compte environ 4,7 Go pour le DiT 2B en bf16, et le contexte CUDA
s'y ajoute). Une carte Pascal de 4 Go ou plus reste à tester pour de bon. Turing et Volta n'empruntent pas ce
chemin, d'après le code, et n'ont pas été testés.

---

## 37. Écran de démarrage (premier lancement)

**Quand il apparaît.** Quand le moteur, lancé par le Studio, doit télécharger des modèles (premier lancement, ou modèle
supprimé), ou qu'il échoue alors qu'il en manque. Il reste jusqu'à ce que le moteur soit prêt, affiche « Prêt » environ deux
secondes, puis laisse place au Studio. Un démarrage ordinaire (modèles déjà sur le disque) ne l'affiche jamais : le voyant
de la barre latérale suffit. Il n'apparaît pas non plus si le moteur n'est pas lancé par le Studio (`MANAGE_PIPELINE`
différent de `true`).

**Ce qu'il montre.** Le matériel détecté (carte, mémoire, mode GPU ou processeur) ; chaque modèle avec sa taille et son
état (en attente, en cours, terminé, échec) ; le temps écoulé ; une alerte si l'espace disque libre ne suffit pas pour les
modèles manquants (marge de 10 %) ; et la raison de l'échec quand il y en a un.

**Pourquoi pas de barre en pourcentage.** Mesuré sur un vrai téléchargement (`huggingface_hub 0.36.2` + `hf_xet`, dossier de
337 Mo) : le fichier partiel reste à 0 octet jusqu'à la fin, et les octets rapportés par Hugging Face arrivent par rafales
(rien pendant 17 s, puis 64 Mio, puis le reste d'un coup). Une barre aurait paru figée, puis aurait sauté. L'écran donne donc
l'état de chaque modèle et les compteurs tels qu'ils arrivent, et le dit. **Le temps restant est une estimation** (« ≈ »),
calculée sur la vitesse des téléchargements déjà terminés : il n'apparaît qu'après le premier.

**Le navigateur s'ouvre dès que le serveur écoute**, au lieu d'attendre que le moteur soit prêt (sur le portable de test :
26 minutes plus tard). `NO_AUTO_BROWSER=true` le désactive, comme avant.

**« Continuer sans attendre »** écarte l'écran pour la session du navigateur. La génération de musique ne fonctionne pas tant
que le moteur n'est pas prêt.

**Sous le capot.** `GET /api/pipeline/status` renvoie `download` (phase, composants, temps, disque, matériel). Le moteur
imprime des lignes `[studio-download] {…}` sur sa sortie standard (`acestep/download_events.py`) ; le serveur les lit et les
retire de la console, où elles deviennent `[Download] <composant> : …`.

**Limites.** Les textes japonais, coréen, russe et chinois sont traduits sans relecture par un locuteur natif. Non testé sur
Windows. Les tailles de certains modèles sont annoncées ou estimées (« ≈ »). L'écran est couvert par des tests automatiques
(logique, composant dans un navigateur simulé) ; son rendu dans un vrai navigateur n'a pas été vérifié par l'auteur du code.

---

## 38. Contrôle des types de l'interface

`cd app && npm run typecheck` (= `tsc --noEmit`) : **0 erreur** attendue.

**Pourquoi ce contrôle ne disait presque rien avant.** `@types/react` et `@types/react-dom` n'étaient ni déclarés ni installés.
TypeScript traitait donc tout React (hooks, composants) comme non typé, et le mode strict étant désactivé il ne s'en plaignait
pas : les 8 erreurs visibles n'étaient que ce qui affleurait. Avec les types, il y en avait 74 dans 14 fichiers. Elles cachaient
de vrais défauts, corrigés par étapes :

- une chanson d'une playlist affichait sa durée en secondes (« 187 ») au lieu de « 3:07 » dans le panneau de droite ;
- 21 clés de traduction manquaient à l'anglais, donc aux autres langues : l'interface affichait l'identifiant brut
  (« allSongs », « uploads », « downloadingModel Nom du modèle... », y compris en français) ;
- des types en retard sur ce que font vraiment le serveur et le moteur (`repaintMode: 'most_natural'`, les optimisations de VRAM de la
  barre latérale, le `mode` de la sélection audio) ;
- du code mort hérité du projet d'origine : les badges, le niveau de compte et « Soutient depuis… » de `UserProfile.tsx`, dont le
  serveur n'envoie jamais les champs.

**Si `npm run typecheck` signale beaucoup d'erreurs sur `react`** : les types ne sont pas installés. `cd app && npm install`.

**S'il signale des modules introuvables dans `server/src`** (`@gradio/client`, `node-id3`...) : le `tsconfig.json` de `app/` n'a pas
d'`include`, donc `tsc` vérifie aussi les 49 fichiers de `app/server/src`, qui ont leurs propres dépendances. `cd app/server && npm install`
(l'installation normale s'en charge déjà).

**Ce que le typage ne verra jamais.** Les écrans d'entraînement LoRA (`LoraPanel`, `DatasetTab`, `ExportTab`, `ModelConfigSection`,
`TrainTab`) reçoivent `t` en paramètre, typé `(key: string) => string` : TypeScript ne peut vérifier aucune de leurs clés. Le test
`app/i18n/usedKeys.test.ts` lit le code source à sa place et échoue si un composant demande une clé absente de l'anglais. Sa liste de dette
connue, `KNOWN_GAP`, est vide depuis que les 40 clés des écrans d'entraînement ont été traduites : toute nouvelle clé manquante fait
échouer le test. `app/i18n/missingKeys.test.ts` vérifie que les clés ajoutées par ce chantier existent dans les six langues.

**Limites connues.** Le mode strict reste désactivé (`strictNullChecks` en particulier) : activer le mode strict ferait apparaître une
classe d'erreurs entièrement différente, à traiter à part. Les textes japonais, coréen, russe et chinois ajoutés par ce chantier ne
sont pas relus par un locuteur natif.

---

## 39. Textes affichés sans traduction : les trois garde-fous

Un texte écrit directement dans un composant, ou une clé absente d'une langue, s'affiche tel quel dans **toutes** les langues : « Rien à
envoyer au moteur… », « Service prêt », « Séparation en cours… » étaient vus par des anglophones. TypeScript ne le voit pas (`tf` accepte
n'importe quelle chaîne, c'est voulu ; un texte en dur n'est qu'une chaîne). Trois tests lisent donc le code à sa place :

- `app/i18n/usedKeys.test.ts` : un `t('clé')` dont la clé n'existe pas dans `en.ts`, y compris dans les écrans d'entraînement LoRA, qui
  reçoivent `t` en paramètre. `KNOWN_GAP`, la liste de dette connue, est vide : n'y ajouter une clé que le temps de la traduire.
- `app/i18n/fallbackKeys.test.ts` : un `tf('clé', 'secours')` dont la clé manque (le secours, souvent en français, s'affichait à tous).
- `app/i18n/hardcodedFrench.test.ts` : du **texte français écrit en dur** (entre balises, `title`, `placeholder`, message d'erreur, libellé
  d'une table de configuration…). Il lit le code comme le compilateur, ignore les commentaires, les comparaisons et le secours d'un
  `t('clé') || 'texte'`, et se vérifie lui-même (cinq cas de contrôle) pour ne pas se taire par erreur.

**Ajouter un texte.** Une clé en `camelCase` dans les **six** fichiers `app/i18n/*.ts`, puis `t('clé')` dans le composant. Pour un texte qui
contient une valeur (une adresse, un code HTTP, une durée), un marqueur `{{nom}}` plutôt qu'une phrase avec la valeur collée :
`fillTemplate(t('clé'), { nom: valeur })` (`app/utils/fillTemplate.ts`). Chaque langue place la valeur où sa grammaire l'exige, et
`formerlyHardcodedKeys.test.ts` vérifie que les six traductions gardent les mêmes marqueurs. Réutiliser une clé existante (`download`,
`pause`, `starting`, `modelLoading`) plutôt que d'en créer une seconde pour le même mot.

**Les noms des modes audio** (`AUDIO_MODES` dans `CreatePanel.tsx`) sont des clés typées `TranslationKey` : une clé inexistante ne compile
pas. « Cover », « Inspiration », « Mashup » et « Sample » restent identiques dans toutes les langues (ce sont des termes).

**Messages du serveur.** Ce que le serveur renvoie ou lance est en **anglais**, comme le reste de son code : il ne connaît pas la langue de
l'interface, donc il ne peut pas la traduire, et l'interface affiche son texte tel quel quand elle le reçoit (`setError(data.error || t('…'))`
ne traduit que le repli). `app/server/src/messageLanguage.test.ts` échoue si un message français y apparaît, dans le TypeScript comme dans
le champ `error` des scripts Python. Les **journaux** (`console.*`, erreur standard des scripts) sont pour le développeur et peuvent rester
dans n'importe quelle langue : quelques-uns sont encore en français, volontairement.

**Ce qui reste, mesuré sur le commit 714c4c7 (analyse de l'arbre syntaxique, avec les limites ci-dessous) :**

- environ 336 textes **anglais** écrits en dur (générateur de vidéo, panneaux des fournisseurs, `CoverRegenModal`…) : une lacune de
  traduction pour les autres langues, pas un affichage dans la mauvaise langue ;

**Limites.** Un texte rangé dans une variable ou une fonction puis affiché plus loin échappe à la lecture du code ; et le test du français en
dur reconnaît les mots par leurs accents et par une courte liste de mots : un mot français simple, sans accent et absent de la liste, passe.
Les textes japonais, coréen, russe et chinois ne sont pas relus par un locuteur natif.

---

## 40. Installer un LoRA depuis Hugging Face (serveur)

Trois routes, avec la même authentification que `/api/lora` : `POST /api/lora-hub/inspect` (qu'y a-t-il dans ce dépôt ?),
`POST /api/lora-hub/install` (lance l'installation et répond tout de suite avec une tâche) et `GET /api/lora-hub/installs/:id` (progression).
Un LoRA installé est rangé dans `ACE-Step-1.5/lora_output/<nom>/`, là où `GET /api/lora/available` le liste déjà : il apparaît tout seul dans le
menu LoRA. Le catalogue et l'interface viennent ensuite ; ce qui existe ici, c'est le moteur d'installation.

**Pourquoi pas un simple téléchargement.** Les LoRA ACE-Step publiés sont hétérogènes : le fichier de poids porte des noms différents
(`adapter_model.safetensors`, `deep_house-v1.safetensors`, `vocal_instrument_merge_adapter_model.safetensors`…) et plusieurs notices disent de le
renommer à la main ; un dépôt peut en contenir plusieurs ; chaque LoRA est lié à un modèle de base (Turbo 2B, base 2B, XL), et un mauvais
appariement donne du bruit ou ne tient pas en 8 Go ; la licence et le mot déclencheur sont dans du texte libre.

**Règles, quelle que soit la source** (un lien collé, plus tard une entrée du catalogue) :

- seuls les fichiers que **l'API du Hub liste elle-même** sont téléchargés : un nom saisi par l'utilisateur est vérifié contre cette liste, jamais
  utilisé comme chemin ;
- seuls `.safetensors` (un format qui ne peut pas exécuter de code) et `adapter_config.json` sont installés ; `.bin`, `.pt`, `.ckpt` sont refusés ;
- les fichiers sont lus **au commit** que l'API a annoncé, pour que ce qui est listé soit ce qui est reçu ;
- l'installation est **atomique** : dossier temporaire caché `.hub-tmp-*`, taille et `sha256` vérifiés, puis un seul renommage ; rien de
  demi-installé n'apparaît dans le menu ;
- jamais de choix silencieux : plusieurs `.safetensors` sans nom standard → la réponse est `choose_file` avec la liste ;
- `cardData` (licence, modèle de base, tags) est du texte libre de l'auteur : seules de courtes chaînes simples en sont gardées ;
- le dossier de destination est assaini (`../`, `checkpoints`, `runs` sont refusés) et **ne contient jamais de point** : `acestep1.5` devient `acestep1_5`, car le moteur
  prend le nom du dossier pour le nom de l'adaptateur et PEFT refuse un « . » dedans (voir le §41, « Charger un LoRA ») ; un LoRA existant n'est jamais écrasé.

**Variables d'environnement** (les mêmes que `huggingface_hub`) : `HF_ENDPOINT` (défaut `https://huggingface.co`) et `HF_TOKEN` ou
`HUGGING_FACE_HUB_TOKEN` pour un dépôt privé ou à accès restreint. Le jeton n'est envoyé qu'au Hub lui-même, jamais au CDN vers lequel il redirige.

**Ce que l'installation écrit** : `adapter_model.safetensors`, `adapter_config.json` et `lora_hub.json` (dépôt, commit, fichier d'origine, `sha256`,
taille, licence, modèle de base, rang, mot déclencheur et réglages recommandés quand l'auteur les publie, date). Les codes d'erreur : `invalid_source`, `not_found`, `forbidden`, `rate_limited`, `unsupported_format`,
`no_weights`, `no_adapter_config`, `unsupported_adapter`, `invalid_adapter_config`, `choose_file` et `unknown_file`, `already_installed`,
`already_installing`, `busy` (deux installations à la fois au plus), `too_large` (4 Go), et, dans la tâche, `checksum_mismatch`, `size_mismatch`,
`download_stalled` (60 s sans données).

**Le catalogue et la compatibilité** (étape 2b). `app/server/catalog/lora-catalog.json` (`"schema": 1`) liste les LoRA proposés ; c'est un pointeur,
jamais une copie : les poids viennent toujours du dépôt de l'auteur, sur le disque de l'utilisateur. Le fichier est lu à chaque requête (le modifier ne
demande pas de redémarrage) et **comme un fichier non fiable** : une entrée invalide est ignorée et signalée dans `problems`, jamais « réparée », et ne fait
pas tomber les autres. Une entrée peut **épingler** le commit (`revision`, 7 à 40 chiffres hexadécimaux : une branche bouge) et le `sha256` des poids : si
le dépôt n'a plus ces poids-là, l'installation refuse (`catalog_checksum_mismatch`), avant le téléchargement quand le Hub publie un checksum, après sinon.
Le catalogue livré n'épingle que ce qui a été installé et vérifié, avec `verified` daté.
Un commit précis est demandé au Hub à `/api/models/<dépôt>/revision/<commit>`, la forme de ses propres clients (`huggingface_hub`, `@huggingface/hub`), et **non** par
un paramètre `?revision=` sur l'adresse de base, que l'API ne lit pas et qui répondrait pour le sommet du dépôt : l'épingle serait alors inutile exactement quand
l'auteur a mis son dépôt à jour. Une révision inconnue est refusée (`not_found`), jamais remplacée par la version actuelle. Le faux Hub des tests se comporte de
même (historique par commit, `?revision=` ignoré, 404 pour une révision inconnue), et un test échoue si la mauvaise forme revient.

Routes : `GET /api/lora-hub/catalog?activeModel=&vramGb=` (chaque entrée avec `installed` et `compatibility`), `POST /api/lora-hub/catalog/:id/install`
(le dépôt, le fichier, le commit et le checksum viennent de l'entrée, **jamais du corps de la requête**), `GET /api/lora-hub/installed`. `POST /inspect` renvoie
en plus `compatibility` et `catalogEntry` : **une entrée prête à coller dans le catalogue**, épinglée sur ce qui vient d'être vu (`verified: null` jusqu'à ce que
le LoRA ait été installé et écouté).

**Compatibilité** (`services/lora-compat.ts`, fonction pure). `incompatible` seulement pour une taille différente : un LoRA 2B ne se charge pas sur un XL, les
couches n'ont pas les mêmes dimensions. Un LoRA entraîné sur Turbo et utilisé sur Base se charge mais donne un autre résultat : `warning`. `compatible` n'est dit
que si la taille ET la famille sont connues des deux côtés et égales ; sinon `unknown`, jamais une supposition. Les sources (fichier de métadonnées, dépôt,
`adapter_config.json`, étiquettes) sont recoupées, et une contradiction est signalée (`conflicting_info`).

**Le modèle chargé vient du client, jamais d'une valeur par défaut du serveur.** Le client le lit dans `GET /api/generate/model-status` (une fois que le moteur
a répondu) et la VRAM dans `/system-info` (`vram_total`, en Go), et les passe en `activeModel` et `vramGb`. Le serveur ne s'en sert pas comme repli : dans
`generate.ts`, `getActiveLoadedModel()` vaut `DEFAULT_MODEL` (`acestep-v15-xl-turbo-bf16`) dès le démarrage, et ne devient le vrai modèle qu'après un sondage
réussi ; avant cela c'est une valeur par défaut, pas un modèle chargé, et un verdict construit dessus serait assuré et faux. Sans `activeModel`, le verdict est
`unknown` (raison `active_model_unknown`), et ce dont le LoRA a besoin est dit quand même. La table des modèles du serveur copie celle du client
(`MODEL_INFO.vramMin`) : un test échoue si elles divergent. Raisons : `size_mismatch`, `family_mismatch`, `comparison_incomplete`, `conflicting_info`,
`vram_low`, `requirement_unknown`, `active_model_unknown`.

**Ajouter une entrée au catalogue** : inspecter un dépôt (`try-lora-hub.mts`, ou `POST /inspect`), copier `catalogEntry`, la coller dans `lora-catalog.json`,
installer le LoRA, l'écouter, puis renseigner `verified`. `npx vitest run server/src/services/lora-catalog.test.ts` vérifie le fichier.

**Le fichier de métadonnées de l'auteur.** Certains auteurs publient `<poids>.metadata.json` (`schema_version: 1`) : mot déclencheur, échelle, étapes,
guidage et décalage recommandés, **modèle de base requis** (`AceStep v1.5 Turbo (2B)`), licence. Il est lu avec les poids et mis sur la fiche
(`card.sidecar`) et dans `lora_hub.json`. Il complète la licence et le modèle de base quand le dépôt n'en déclare pas (ordre : dépôt, étiquette
`license:`, fichier de métadonnées). C'est la parole de l'auteur, pas une vérité : son `sha256` et le nom du fichier de poids sont comparés à ceux
du Hub, et un fichier absent, illisible, trop gros ou faux n'empêche **jamais** une inspection ni une installation (il devient un avertissement) ;
son texte est nettoyé comme tout ce que l'auteur écrit. Un chemin de dossier d'auteur (`/root/checkpoints/acestep-v15-turbo`) est réduit à son
dernier segment. Peu d'auteurs en publient un : le catalogue devra donc porter ces informations lui aussi.

**Limites.** Exécuté une fois contre le vrai Hub (`ryanontheinside/lo_fi-acestep1.5-v1`, 88 Mo : installation et somme de contrôle vérifiées) ; le reste
est testé contre un faux Hub local (`services/lora-hub.fake.ts`) construit d'après cette forme réelle. Un LoRA d'un autre type que `LORA` (par exemple
LoKr) est refusé. « Licence non déclarée » est une réponse normale : celui-là n'en déclare aucune, ni dans le dépôt ni dans son fichier.

---

## 41. Catalogue de LoRA : l'interface

Le bouton « Parcourir le catalogue » du panneau LoRA (`components/LoraPanel.tsx`) ouvre `components/LoraCatalogModal.tsx` : la liste du catalogue
(`/api/lora-hub/catalog`), un champ « lien Hugging Face » (`/inspect`, `/install`) et le suivi des installations (`/installs/:id`). Les appels, les
erreurs et toute la logique d'affichage sont dans `services/loraHub.ts`, sans React, pour être testés seuls.

**Le serveur envoie des codes, jamais des phrases.** Une raison de compatibilité (`size_mismatch`…) et une erreur (`catalog_checksum_mismatch`, `busy`…)
sont écrites dans la langue de l'utilisateur, avec les textes `loraHub*` des six langues. La phrase anglaise du serveur ne s'affiche que pour un code que
l'interface ne connaît pas. Le client garde le code et les détails d'une erreur (le wrapper `api()` de `services/api.ts` ne garde que « 409: message ») : il
en a besoin pour la liste des fichiers à choisir. `loraHub.test.ts` lit les codes du serveur (`new LoraHubError(…)`) et échoue si l'un d'eux n'a ni phrase ni
raison d'être traité ailleurs.

**Le modèle chargé** n'est cru que si le moteur est connecté ET prêt (`state === 'ready' && connected`), la règle que `CreatePanel` applique déjà. Pendant un
chargement, un déchargement ou une erreur, il est omis : le verdict est « Inconnu », dit une seule fois en haut de la fenêtre plutôt que sur chaque carte. La VRAM
vient de `/api/generate/system-info` (`vram_total`, en Go).

**« Utiliser »** sélectionne le LoRA dans la liste et règle l'échelle recommandée par l'auteur (limitée à 0–1, ce que le curseur peut montrer), **sauf si un LoRA est
déjà chargé** : le curseur agit alors sur celui-là. Le chargement reste le geste explicite du bouton « Charger », qui garde ses garde-fous (quantification…). Il
est refusé pour un LoRA incompatible (taille de modèle différente). Le mot déclencheur et les réglages affichés sous la liste viennent de `/api/lora-hub/installed`
(`lora_hub.json`) : un LoRA entraîné ici n'a pas ce fichier et n'a pas ce bloc.

**Pièges déjà rencontrés.** `LoraPanel` est rendu à chaque frappe de `CreatePanel` et passe de nouvelles fonctions à la fenêtre à chaque fois : les rappels
(`onClose`, `onInstalled`) et ce qu'on injecte (`api`, `readContext`) sont lus par référence, sinon le minuteur de progression est relancé à chaque rendu et ne
tire jamais. Un test de régression le garde. Les couleurs des raisons suivent la gravité de CHAQUE raison, pas le verdict de la carte.
La fenêtre est rendue dans `document.body` (un portail) : la colonne de gauche de la page de création est son propre contexte d'empilement, et un `z-50` écrit à
l'intérieur y restait sous la poignée qui redimensionne les deux colonnes, qui traversait alors la fenêtre. Les tests cherchent donc dans `document.body`, pas dans leur conteneur.

**Ajouter ou changer un texte** : les clés `loraHub*` des six `i18n/*.ts` ; `i18n/loraHubKeys.test.ts` vérifie qu'elles existent partout, avec les mêmes `{{marqueurs}}`,
sans copie de l'anglais, et que le français vouvoie.

**Limites.** Vérifié dans un vrai navigateur (Chromium) avec un faux serveur : thèmes clair et sombre, anglais, français, japonais, russe en écran étroit, mesure de
débordement dans les six langues. **Pas vérifié** : l'installation depuis l'interface contre le vrai Hugging Face, ni la fenêtre dans l'application entière. Les textes
japonais, coréen, russe et chinois ne sont pas relus par un locuteur natif ; le coréen et le chinois n'ont pas été regardés à l'écran. Les tailles restent en « MB »
dans toutes les langues, et les descriptions du catalogue sont le texte (anglais) de l'auteur.

**Charger un LoRA : ce que dit le moteur.** `POST /api/lora/load` répondait `200` avec `loaded: true` même quand le moteur répondait « ❌ Failed to load LoRA… » : le panneau
affichait « LoRA chargé » pour un LoRA absent, et le parent désactivait `thinking` et `useAdg`. Elle lit maintenant la réponse (`services/lora-engine-status.ts`) : un échec
annoncé donne un `422` avec le texte du moteur sans sa marque, et l'état n'est pas modifié (un LoRA déjà chargé le reste). L'erreur la plus courante est
`module name can't contain "."` : le moteur prend le **nom du dossier** pour le nom de l'adaptateur. La route ne l'attribue au dossier que si le moteur le dit ET que le dossier
a un point (jamais sur une supposition) ; elle nomme alors le dossier et propose le nom corrigé. Le texte du moteur est le `str()` d'une `KeyError` Python, donc le `repr()` du
message : l'apostrophe arrive avec une barre oblique inverse (`can\'t`), et la reconnaissance accepte les deux formes. (Ce message a longtemps été attribué au nom du fichier de
poids ; celui-là est renommé par `GET /api/lora/available`, et le message cite le dossier.)

**Réparer un dossier installé avec un point** : `mv lora_output/lo_fi-acestep1.5-v1 lora_output/lo_fi-acestep1_5-v1`. Le nom du dossier n'est écrit nulle part dans `lora_hub.json`,
et le catalogue retrouve le LoRA par son dépôt et son fichier : il reste « Installé ».

**Limites.** Seuls les échecs annoncés par « ❌ » ou « Failed to load » sont reconnus ; une autre formulation passerait encore pour un succès. `unload`, `scale` et `toggle` lisent aussi
un texte d'état et ne le contrôlent pas. Le renommage corrigé n'a pas été essayé avec le vrai moteur : il repose sur ce que dit son message d'erreur.

---

## 42. Modèles : la liste, la VRAM et le téléchargement

**Une seule table.** `services/model-downloads.ts` dit quels modèles DiT le Studio propose ET d'où chacun se télécharge (`MODEL_DOWNLOADS`, `LISTED_DIT_MODELS`). Avant, la liste
(`GET /api/generate/models`) était écrite en dur dans `routes/generate.ts` avec les seuls XL, et une seconde copie servait au téléchargement : les 2B (Turbo, SFT, Base) n'apparaissaient
dans aucun menu, et on ne pouvait pas les choisir depuis le Studio. Un test lit les deux côtés et échoue si la liste, la table de téléchargement, `MODEL_INFO` (client) ou l'ordre du menu divergent.

**Le Turbo 2B n'a pas de dépôt à lui** : c'est le dossier `acestep-v15-turbo/` du dépôt `ACE-Step/Ace-Step1.5`. Il est donc téléchargé avec `--include 'acestep-v15-turbo/*'` dans
`checkpoints/` (et non `--local-dir checkpoints/acestep-v15-turbo`, qui créerait un dossier de plus). Base et SFT ont chacun leur dépôt, dont les fichiers sont à la racine.
**SFT : la disposition du dépôt n'a pas été vérifiée** (elle est supposée identique à celle de Base).

**Le filtre par VRAM** (`utils/modelFit.ts`, `components/ModelMenu.tsx`). La mémoire de la carte vient de `/api/generate/system-info` (`vram_total`, en Go). Un modèle dont le `vramMin`
(`MODEL_INFO`) dépasse la mémoire de plus de 0,5 Go est replié derrière le lien « Afficher les modèles qui demandent plus de VRAM (N) » ; une fois déplié, chacun porte la note « Demande
12 Go de VRAM (vous en avez 8 Go) ». La marge de 0,5 Go existe parce qu'une carte « 8 Go » annonce 7,6 à 7,9 Go une fois le pilote servi. Rien n'est jamais refusé : `vramMin` est une
estimation (le déchargement CPU fait tourner des modèles plus gros, lentement), d'où un lien et non une interdiction.

**Ce qui n'est jamais masqué** : tout si la mémoire est inconnue (pas de carte NVIDIA, serveur pas encore démarré, requête en échec) ; un modèle absent de `MODEL_INFO` (personnalisé,
fusionné) ; le modèle sélectionné, le modèle chargé, et ceux déjà présents sur le disque.

**Ajouter un modèle** : une entrée dans `MODEL_DOWNLOADS` et `LISTED_DIT_MODELS`, une dans `MODEL_INFO`, une dans `FIXED_ORDER` de `ModelMenu.tsx`. Le test échoue tant qu'il en manque une.

**Limites.** Vérifié dans un vrai navigateur (Chromium) avec le vrai serveur et un faux `nvidia-smi` à 8 Go : liste, lien, notes, anglais et français, six langues sans débordement.
**Pas vérifié** : le téléchargement réel du Turbo 2B (le Hugging Face réel n'a pas été joint), le chargement d'un 2B par le vrai moteur, et le réglage du moteur de langage pour un 2B.
Le japonais, le coréen, le russe et le chinois ne sont pas relus par un locuteur natif. `services/acestep.ts` garde sa propre copie de `MODEL_HF_REPOS`, non touchée.
