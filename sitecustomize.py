"""
sitecustomize.py

Charge automatiquement par Python au demarrage de l'interpreteur (mecanisme
standard du module site), avant meme le code d'ACE-Step-1.5 : permet de
filtrer des messages precis sans toucher au code source amont.

Principe : chaque filtre vise le TEXTE exact d'un message connu et sans
consequence, jamais une categorie entiere ni un logger entier. Tout autre
avertissement des memes bibliotheques reste affiche.

Messages filtres (tous verifies sans effet sur ACE-Step) :

1. torch.utils._pytree — "<enum 'KernelPreference'> is an Enum subclass and
   is now natively supported by torch.compile..." : torchao (0.17 et 0.18)
   enregistre encore ses Enum via register_constant(), procede deprecie
   depuis PyTorch 2.14. Purement informatif tant que torchao n'a pas suivi.

2. diffusers (quantizers/torchao) — "Unable to import `torchao` Tensor
   objects..." : diffusers tente d'importer NF4Tensor et UintxTensor depuis
   torchao.dtypes, que torchao 0.18 a supprimes (fin de la pile v1
   AffineQuantizedTensor). Ne concerne que le chargement de checkpoints
   serialises avec torchao via diffusers, ce qu'ACE-Step ne fait pas.

3. diffusers (models/modeling_utils) — "There are modules in
   AutoencoderOobleck that should be kept in float32: []..." : message
   generique emis des qu'un modele est caste via .to(dtype). Filtre
   UNIQUEMENT quand la liste est vide ([]) : si un jour un module est
   reellement concerne, le message reapparait.
   NB : l'ancienne version de ce fichier utilisait warnings.filterwarnings,
   sans effet car diffusers passe par logging (logger.warning), pas par le
   module warnings.

4. transformers — "`torch_dtype` is deprecated! Use `dtype` instead!" :
   renommage d'argument, l'ancien nom fonctionne toujours.

5. Niveau loguru par defaut : INFO au lieu de DEBUG (masque les lignes
   DEBUG de demarrage). Pour revenir au mode verbeux : LOGURU_LEVEL=DEBUG
   dans l'environnement, qui reste prioritaire.
"""
import logging
import os
import warnings

# 5. loguru lit LOGURU_LEVEL a son import : doit etre pose avant.
os.environ.setdefault("LOGURU_LEVEL", "INFO")


class _DropKnownMessages(logging.Filter):
    """Rejette les enregistrements dont le texte contient un fragment connu."""

    def __init__(self, *fragments: str) -> None:
        super().__init__()
        self._fragments = fragments

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            message = record.getMessage()
        except Exception:
            return True  # message mal forme : on le laisse passer
        return not any(fragment in message for fragment in self._fragments)


_PYTREE_ENUM = "is an Enum subclass and is now natively supported by torch.compile"
_TORCHAO_TENSORS = "Unable to import `torchao` Tensor objects"
_FP32_EMPTY = "that should be kept in float32: []"
_TORCH_DTYPE = "`torch_dtype` is deprecated! Use `dtype` instead!"

_RULES = {
    "torch.utils._pytree": (_PYTREE_ENUM,),
    "diffusers.quantizers.torchao.torchao_quantizer": (_TORCHAO_TENSORS,),
    "diffusers.models.modeling_utils": (_FP32_EMPTY,),
    "transformers.configuration_utils": (_TORCH_DTYPE,),
    "transformers.modeling_utils": (_TORCH_DTYPE,),
}

for _name, _fragments in _RULES.items():
    logging.getLogger(_name).addFilter(_DropKnownMessages(*_fragments))

# Filet de securite si une version future passe ces messages par le module
# warnings plutot que par logging.
warnings.filterwarnings("ignore", message=r".*" + _PYTREE_ENUM)
warnings.filterwarnings(
    "ignore", message=r"There are modules in .* that should be kept in float32: \[\]"
)
