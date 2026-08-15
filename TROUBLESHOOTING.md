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

**Symptôme.** Audio saturé, écrêté, sans dynamique.

Un `Peak=1.0000` avant normalisation est un indice, **pas une preuve** : le
modèle produit aussi ce pic sans DCW. Seule l'absence de la ligne
`[DCW] Active` dans les logs confirme la désactivation.

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
