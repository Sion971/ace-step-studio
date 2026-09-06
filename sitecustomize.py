"""
sitecustomize.py

Charge automatiquement par Python au demarrage de l'interpreteur (mecanisme
standard, documente dans la doc officielle du module site), avant meme le
code d'ACE-Step-1.5 — permet de filtrer un avertissement precis sans
jamais toucher au code source amont.

Avertissement vise : diffusers emet un FutureWarning generique des qu'un
modele (ici AutoencoderOobleck, l'auto-encodeur audio du pipeline) est
caste directement via `.to(dtype)` plutot que charge avec `torch_dtype=`
des `from_pretrained()`. Confirme sans consequence reelle dans notre cas
precis : le message liste explicitement quels modules risqueraient une
imprecision numerique s'ils repassaient en float32, et cette liste est
vide ([]) — rien n'est concretement affecte ici, juste un message
generique qui se declenche independamment du contenu de cette liste.

Filtre delibere sur le TEXTE exact du message, pas sur la categorie
FutureWarning entiere — un filtre trop large masquerait aussi d'autres
avertissements futurs potentiellement utiles, de diffusers ou d'ailleurs.
"""
import warnings

warnings.filterwarnings(
    "ignore",
    message=r"There are modules in .* that should be kept in float32",
    category=FutureWarning,
)
