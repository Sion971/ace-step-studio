@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

REM ============================================================================
REM  ACE-Step Studio - installation unique (Windows)
REM
REM  Remplace install.bat (pile eprouvee, torch 2.7.1) ET install-blackwell-native.bat
REM  (variante experimentale RTX 50xx) : meme principe que install.sh sous Linux.
REM  Un seul fichier, un seul menu, les memes piles que Linux :
REM    - CUDA 13.0 : PyTorch 2.14.1, triton-windows 3.8, roue flash-attn precompilee
REM    - CUDA 12.8 : PyTorch 2.11.0, triton-windows 3.6 ^(pas de roue flash-attn verifiee^)
REM    - CUDA 12.6 : PyTorch 2.11.0, anciennes cartes ^(Pascal, Volta^), sans flash-attn
REM    - CPU       : PyTorch 2.11.0
REM  Python 3.12 pour l'environnement principal ^(la roue flash-attn est cp312^).
REM
REM  Ce fichier est en ASCII pur ^(pas d'accents^) : voir le commentaire en tete de run.bat.
REM ============================================================================

echo ========================================
echo   ACE-Step Studio - Installation ^(Windows^)
echo ========================================
echo.

set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"
if not exist "temp" mkdir temp
set "TEMP=%SCRIPT_DIR%temp"
set "TMP=%SCRIPT_DIR%temp"
REM Xet est le mecanisme de transfert actif par defaut depuis
REM huggingface_hub 0.32.0 ou plus - accelere tout telechargement eventuel pendant
REM l'installation, quelle que soit la version de huggingface_hub installee.
set "HF_XET_HIGH_PERFORMANCE=1"

REM === 1. Arborescence ==========================================================
echo [1/14] Creation des repertoires de travail...
if not exist "downloads" mkdir downloads
if not exist "models" mkdir models
if not exist "cache" mkdir cache
if not exist "app\data" mkdir "app\data"
if not exist "app\server\public\audio" mkdir "app\server\public\audio"

REM Les datasets et sorties LoRA vivent sous ACE-Step-1.5\, jamais a la
REM racine : run.bat definit DATASETS_DIR=...\ACE-Step-1.5\datasets et le
REM moteur resout ses chemins relatifs depuis ACE-Step-1.5\. Les creer a la
REM racine du Studio les rend invisibles au pipeline.
if not exist "ACE-Step-1.5\datasets\uploads" mkdir "ACE-Step-1.5\datasets\uploads"
if not exist "ACE-Step-1.5\datasets\preprocessed_tensors" mkdir "ACE-Step-1.5\datasets\preprocessed_tensors"
if not exist "ACE-Step-1.5\lora_output" mkdir "ACE-Step-1.5\lora_output"

REM === 2. Detection du materiel (lecture seule) ================================
REM Rien n'est installe ici. Sert a SUGGERER une option du menu et a controler le
REM plancher de pilote de la pile choisie. GPU 0 uniquement, comme le moteur.
REM Sans nvidia-smi ^(pas de pilote NVIDIA, ou GPU AMD/Intel^) : aucune suggestion.
set "HW_GPU_NAME="
set "HW_VRAM_MIB="
set "HW_CC="
set "HW_CC_INT="
set "HW_DRIVER="
set "HW_DRV_MAJOR="
set "DRIVER_CUDA10=0"
set "HW_SUGGESTED="
where nvidia-smi >nul 2>nul
if errorlevel 1 goto :hw_done
for /f "tokens=1-3 delims=," %%a in ('nvidia-smi --query-gpu^=name^,memory.total^,compute_cap --format^=csv^,noheader^,nounits 2^>nul') do if not defined HW_GPU_NAME set "HW_GPU_NAME=%%a" & set "HW_VRAM_MIB=%%b" & set "HW_CC=%%c"
for /f "tokens=*" %%d in ('nvidia-smi --query-gpu^=driver_version --format^=csv^,noheader 2^>nul') do if not defined HW_DRIVER set "HW_DRIVER=%%d"
if defined HW_VRAM_MIB set /a HW_VRAM_MIB=%HW_VRAM_MIB% 2>nul
if defined HW_CC for /f "tokens=*" %%x in ("%HW_CC%") do set "HW_CC=%%x"
if defined HW_CC set "HW_CC_INT=%HW_CC:.=%"
if defined HW_DRIVER for /f "tokens=1 delims=." %%m in ("%HW_DRIVER%") do set "HW_DRV_MAJOR=%%m"

REM Version CUDA maximale du pilote, deduite du NUMERO de pilote ^(table des pilotes
REM minimaux publiee par NVIDIA, la meme que dans install.sh^). Exprimee x10 : 130 = CUDA 13.0.
if not defined HW_DRV_MAJOR goto :hw_cc
if %HW_DRV_MAJOR% GEQ 525 set "DRIVER_CUDA10=120"
if %HW_DRV_MAJOR% GEQ 570 set "DRIVER_CUDA10=128"
if %HW_DRV_MAJOR% GEQ 580 set "DRIVER_CUDA10=130"
if %HW_DRV_MAJOR% GEQ 590 set "DRIVER_CUDA10=131"
if %HW_DRV_MAJOR% GEQ 595 set "DRIVER_CUDA10=132"

:hw_cc
REM CUDA 13.x couvre toutes les cartes a partir de Turing ^(capacite 7.5^) ; en dessous
REM ^(Pascal 6.x, Volta 7.0^) : pile CUDA 12.6, derniere a les couvrir.
if not defined HW_CC_INT goto :hw_done
set "HW_SUGGESTED=2"
if %HW_CC_INT% GEQ 75 set "HW_SUGGESTED=1"

:hw_done
echo [2/14] Materiel
if defined HW_GPU_NAME (
    set /a HW_VRAM_GB=^(HW_VRAM_MIB+512^)/1024
    echo   GPU detecte : !HW_GPU_NAME! - !HW_VRAM_GB! Go de VRAM, capacite de calcul !HW_CC!
    if not "!DRIVER_CUDA10!"=="0" echo   Pilote NVIDIA : prend en charge CUDA !DRIVER_CUDA10:~0,2!.!DRIVER_CUDA10:~2! au maximum
) else (
    echo   Aucun GPU NVIDIA detecte ^(nvidia-smi absent ou muet^).
    echo   Si vous avez une carte NVIDIA, installez d'abord son pilote, puis relancez ce script.
)

echo.
echo Selectionnez votre GPU :
echo.
echo   1. NVIDIA RTX 20xx ou plus recente ^(Turing, Ampere, Ada, Blackwell^) - CUDA 13.0 ou 12.8
echo   2. NVIDIA GTX 10xx ^(Pascal^) ou Volta                              - CUDA 12.6
echo   3. CPU uniquement ^(pas de GPU^)
echo   4. AMD ou Intel ^(non gere par ce script, voir le message^)
echo.
set "GPU_CHOICE="
if defined HW_SUGGESTED (
    set /p "GPU_CHOICE=Entrez votre choix 1-4 [suggestion : !HW_SUGGESTED!] : "
) else (
    set /p "GPU_CHOICE=Entrez votre choix 1-4 : "
)
if "%GPU_CHOICE%"=="" set "GPU_CHOICE=%HW_SUGGESTED%"

if "%GPU_CHOICE%"=="1" goto :opt_nvidia
if "%GPU_CHOICE%"=="2" goto :opt_legacy
if "%GPU_CHOICE%"=="3" goto :opt_cpu
if "%GPU_CHOICE%"=="4" goto :opt_other
echo Choix invalide.
pause
exit /b 1

:opt_other
REM AMD ^(ROCm^) et Intel ^(XPU^) ne sont PAS geres par cet installateur - non par choix,
REM mais par honnetete : personne n'a de materiel AMD ou Intel pour verifier quoi que ce
REM soit ici. ROCm sous Windows n'utilise pas un simple --index-url comme CUDA, mais des
REM roues specifiques a CHAQUE architecture GPU exacte, avec un bug documente cote AMD.
REM Le projet ACE-Step-1.5 maintient ses propres scripts dedies, testes par une equipe
REM qui a reellement ce materiel : s'appuyer dessus plutot que de reimplementer a l'aveugle.
echo.
echo ========================================
echo   Support AMD / Intel
echo ========================================
echo.
echo Ce Studio est construit et teste specifiquement pour NVIDIA/CUDA. AMD ^(ROCm^) et
echo Intel ^(XPU^) ne sont pas verifies avec cet installateur.
echo.
echo Pour utiliser ACE-Step 1.5 sur GPU AMD ou Intel, suivez le guide officiel du projet
echo directement dans le dossier ACE-Step-1.5 :
echo.
echo   AMD ^(ROCm^)   : start_gradio_ui_rocm.bat
echo   Intel ^(XPU^)  : setup_xpu.bat, puis start_gradio_ui_xpu.bat
echo.
echo Guide complet : https://github.com/ace-step/ACE-Step-1.5/blob/main/docs/en/INSTALL.md
echo.
pause
exit /b 0

:opt_cpu
set "CUDA_VERSION=cpu"
set "CUDA_NAME=CPU only"
set "TORCH_VERSION=2.11.0"
set "TORCHAUDIO_VERSION=2.11.0"
set "TRITON_SPEC="
set "FLASH_URL="
set "FLASH_NOTE=pas de GPU"
set "DRIVER_NEEDED=0"
goto :stack_done

:opt_legacy
REM Pascal ^(6.x^), Volta ^(7.0^) : CUDA 13.x ne les prend plus en charge. CUDA 12.6 est la
REM derniere pile a les couvrir. flash-attn exige une capacite 8.0 ou plus : SDPA prend le relais.
set "CUDA_VERSION=cu126"
set "CUDA_NAME=CUDA 12.6 ^(anciennes cartes^)"
set "TORCH_VERSION=2.11.0"
set "TORCHAUDIO_VERSION=2.11.0"
set "TRITON_SPEC=>=3.6.0,<3.7"
set "FLASH_URL="
set "FLASH_NOTE=cartes anciennes : flash-attn exige une capacite 8.0 ou plus"
set "DRIVER_NEEDED=120"
set "DRIVER_SERIES=525"
goto :stack_done

:opt_nvidia
REM Une RTX 50xx n'est reconnue qu'a partir du pilote 570 ^(CUDA 12.8^) : en dessous,
REM AUCUNE pile ne fonctionne. Le dire avant d'installer plusieurs Go de paquets.
set "BLK_WARN="
if defined HW_CC_INT if %HW_CC_INT% GEQ 100 if %DRIVER_CUDA10% GTR 0 if %DRIVER_CUDA10% LSS 128 set "BLK_WARN=1"
if not defined BLK_WARN goto :stack_menu
echo.
echo ERREUR : votre pilote NVIDIA ne gere que CUDA !DRIVER_CUDA10:~0,2!.!DRIVER_CUDA10:~2!.
echo   Une RTX 50xx exige un pilote 570 ou plus ^(CUDA 12.8^) ; 580 ou plus pour la pile CUDA 13.0.
echo   Mettez a jour le pilote NVIDIA, puis relancez ce script.
call :ask_continue
if errorlevel 1 exit /b 1

:stack_menu
REM Pile CUDA : la plus recente que le pilote permet. La detection ne fait que PRESELECTIONNER.
REM   CUDA 13.0 + PyTorch 2.14.1 : defaut de PyTorch ; exige un pilote NVIDIA 580 ou plus.
REM   CUDA 12.8 + PyTorch 2.11.0 : pour les pilotes plus anciens ^(derniere pile cu128^).
REM CUDA 13.2 n'est pas propose : classe experimental par PyTorch.
set "ST_DEFAULT=2"
if %DRIVER_CUDA10% GEQ 130 set "ST_DEFAULT=1"
echo.
echo Pile CUDA :
echo   1. CUDA 13.0 - PyTorch 2.14.1 ^(la plus recente ; exige un pilote NVIDIA 580 ou plus^)
echo   2. CUDA 12.8 - PyTorch 2.11.0 ^(pilotes plus anciens ; sans flash-attn precompile^)
if "%DRIVER_CUDA10%"=="0" (
    echo   Pilote NVIDIA non detecte ^(nvidia-smi^) - suggestion prudente : option 2.
) else (
    echo   Pilote detecte : CUDA !DRIVER_CUDA10:~0,2!.!DRIVER_CUDA10:~2! - suggestion : option %ST_DEFAULT%.
)
if "%DRIVER_CUDA10%"=="0" set "ST_DEFAULT=2"
set "ST_CHOICE="
set /p "ST_CHOICE=Votre choix [%ST_DEFAULT%] : "
if "%ST_CHOICE%"=="" set "ST_CHOICE=%ST_DEFAULT%"
if "%ST_CHOICE%"=="1" goto :stack_cu130
if "%ST_CHOICE%"=="2" goto :stack_cu128
echo Choix invalide.
pause
exit /b 1

:stack_cu130
set "CUDA_VERSION=cu130"
set "CUDA_NAME=CUDA 13.0"
set "TORCH_VERSION=2.14.1"
REM torchaudio reste epingle a 2.11.0 : derniere version publiee ^(projet en fin de vie,
REM ABI stable, aucune dependance declaree vers torch^), comme sur Linux.
set "TORCHAUDIO_VERSION=2.11.0"
REM torch epingle une version de Triton PRECISE par version mineure : torch 2.14 donne Triton 3.8
REM ^(declare par torch 2.14.1 lui-meme : triton~=3.8.0^). triton-windows suit la meme numerotation.
set "TRITON_SPEC=>=3.8.0,<3.9"
REM Roue communautaire mjun0812/flash-attention-prebuild-wheels : Python 3.12, torch 2.14, CUDA 13.0.
REM Contient les noyaux sm_80, sm_90, sm_100 et sm_120 ^(verifie dans le binaire^) : RTX 30xx, 40xx
REM et 50xx. Une carte 8.6 ou 8.9 execute le noyau sm_80 ^(compatibilite binaire dans la meme famille^).
set "FLASH_URL=https://github.com/mjun0812/flash-attention-prebuild-wheels/releases/download/v0.10.2/flash_attn-2.8.3+cu130torch2.14-cp312-cp312-win_amd64.whl"
set "FLASH_NOTE="
set "DRIVER_NEEDED=130"
set "DRIVER_SERIES=580"
goto :stack_done

:stack_cu128
set "CUDA_VERSION=cu128"
set "CUDA_NAME=CUDA 12.8"
set "TORCH_VERSION=2.11.0"
set "TORCHAUDIO_VERSION=2.11.0"
set "TRITON_SPEC=>=3.6.0,<3.7"
REM Aucune roue flash-attn Windows verifiee pour torch 2.11 / cu128 / Python 3.12 : SDPA prend le relais.
set "FLASH_URL="
set "FLASH_NOTE=pas de roue precompilee verifiee pour la pile CUDA 12.8 sous Windows"
set "DRIVER_NEEDED=120"
set "DRIVER_SERIES=525"

:stack_done
echo.
echo Option selectionnee : %CUDA_NAME%
echo.

REM === 2a. Pilote NVIDIA : plancher de chaque pile ==============================
REM PyTorch ne voit pas le GPU si le pilote est plus ancien que la pile : autant le dire avant.
if "%CUDA_VERSION%"=="cpu" goto :driver_ok
if "%DRIVER_CUDA10%"=="0" goto :driver_unknown
if %DRIVER_CUDA10% GEQ %DRIVER_NEEDED% goto :driver_fine
echo ERREUR : votre pilote NVIDIA ne gere que CUDA !DRIVER_CUDA10:~0,2!.!DRIVER_CUDA10:~2!.
echo   La pile %CUDA_NAME% exige un pilote de la serie %DRIVER_SERIES% ou plus recente :
echo   PyTorch ne verrait pas votre GPU. Mettez a jour le pilote NVIDIA, puis relancez ce script.
call :ask_continue
if errorlevel 1 exit /b 1
goto :driver_ok
:driver_unknown
echo ATTENTION : version CUDA du pilote illisible ^(nvidia-smi^) - verification ignoree.
goto :driver_ok
:driver_fine
echo Pilote NVIDIA : CUDA !DRIVER_CUDA10:~0,2!.!DRIVER_CUDA10:~2! - compatible avec la pile %CUDA_VERSION%.
:driver_ok
echo.

REM === 2b. flash-attn : eligibilite reelle, selon la capacite de calcul ==========
REM Son noyau CUDA officiel exige une capacite 8.0 ou plus ^(Ampere et plus recent^).
REM En dessous, SDPA reste pleinement fonctionnel ^(repli automatique, plus lent mais correct^).
set "FLASH_OK=0"
if "%FLASH_URL%"=="" goto :flash_elig_done
if not defined HW_CC_INT (
    set "FLASH_NOTE=GPU non detecte par nvidia-smi : eligibilite impossible a verifier"
    goto :flash_elig_done
)
if %HW_CC_INT% GEQ 80 (
    set "FLASH_OK=1"
    echo GPU detecte : capacite de calcul %HW_CC% - flash-attn sera installe.
) else (
    set "FLASH_NOTE=capacite de calcul %HW_CC% : flash-attn exige 8.0 ou plus"
)
:flash_elig_done
echo.

REM === 3. uv ====================================================================
REM uv gere lui-meme le telechargement et la mise en place de Python. Meme outil que
REM sous Linux ^(install.sh^). Point d'attention Windows : l'installeur uv modifie le PATH
REM utilisateur PERSISTANT, mais cela ne s'applique qu'aux FUTURES fenetres cmd : on ajoute
REM donc explicitement son dossier au PATH de cette session.
where uv >nul 2>nul
if errorlevel 1 goto :uv_install
echo [OK] uv deja installe
goto :uv_done
:uv_install
if exist "%USERPROFILE%\.local\bin\uv.exe" goto :uv_path
echo [3/14] Installation de uv...
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
if not exist "%USERPROFILE%\.local\bin\uv.exe" (
    echo ERREUR : l'installation de uv a echoue.
    pause
    exit /b 1
)
:uv_path
set "PATH=%USERPROFILE%\.local\bin;%PATH%"
:uv_done

REM === 4. Environnement virtuel Python 3.12 =====================================
REM Python 3.12 ^(et non plus 3.11^) : la roue flash-attn est cp312. Comme install.sh, on
REM repart d'un environnement vierge : un ancien .venv en Python 3.11 serait inutilisable.
echo [4/14] Environnement virtuel Python 3.12...
if exist ".venv" (
    echo Suppression de l'ancien environnement pour un reset propre...
    rmdir /s /q ".venv"
)
if exist ".venv\Scripts\python.exe" (
    echo ERREUR : impossible de supprimer .venv ^(une fenetre run.bat est-elle encore ouverte ?^).
    echo Fermez-la, puis relancez ce script.
    pause
    exit /b 1
)
uv venv --python 3.12 .venv
if errorlevel 1 (
    echo ERREUR : la creation de l'environnement virtuel a echoue.
    pause
    exit /b 1
)
call .venv\Scripts\activate.bat

REM Controle de l'interpreteur AVANT de telecharger quoi que ce soit. Cas rencontre sous Windows 11 :
REM "DLL load failed while importing _overlapped : Une strategie de controle d'application a bloque ce
REM fichier" - Windows refuse de charger les fichiers du Python telecharge par uv ^(non signes^), et
REM TOUT script Python qui utilise asyncio ^(Gradio, uvicorn...^) echouerait alors, torch ou pas.
REM Premier essai de contournement : un Python 3.12 deja installe sur la machine ^(celui de python.org
REM est signe^), choisi par uv avec --python-preference only-system. Sinon, message clair.
.venv\Scripts\python.exe -c "import asyncio, ssl, sqlite3, ctypes" >nul 2>"%TEMP%\py_check.txt"
if not errorlevel 1 goto :python_ok
echo.
echo ERREUR : cet interpreteur Python ne peut pas charger ses propres modules ^(erreur ci-dessous^) :
type "%TEMP%\py_check.txt"
echo.
echo Essai avec un Python 3.12 installe sur la machine ^(signe^) a la place...
rmdir /s /q ".venv"
uv venv --python 3.12 --python-preference only-system .venv
if errorlevel 1 goto :python_blocked
call .venv\Scripts\activate.bat
.venv\Scripts\python.exe -c "import asyncio, ssl, sqlite3, ctypes" >nul 2>nul
if errorlevel 1 goto :python_blocked
echo   OK - Python 3.12 du systeme utilise.
goto :python_ok
:python_blocked
echo.
echo   Impossible d'obtenir un Python utilisable. Si l'erreur ci-dessus parle d'une strategie de
echo   controle d'application ^(Smart App Control, WDAC, AppLocker^), Windows bloque les fichiers du
echo   Python telecharge par uv. Solution : installer Python 3.12 depuis https://www.python.org/downloads/
echo   ^(binaires signes par la Python Software Foundation^), puis relancer ce script.
echo   Details et diagnostic : TROUBLESHOOTING.md.
pause
exit /b 1
:python_ok

REM Outils de build ^(pas de cmake ni ninja : aucune compilation sous Windows, roues precompilees^).
uv pip install hatchling editables setuptools wheel

REM === 5. PyTorch ===============================================================
echo [5/14] PyTorch %TORCH_VERSION% ^(%CUDA_NAME%^)...
if "%CUDA_VERSION%"=="cpu" goto :torch_cpu

REM Garde AVANT telechargement : l'index PyTorch propose-t-il torch %TORCH_VERSION% pour cette
REM pile ET pour Windows / Python 3.12 ? Silencieuse si curl est absent ou l'index injoignable :
REM uv dira alors lui-meme ce qui ne va pas.
set "PT_INDEX=https://download.pytorch.org/whl/%CUDA_VERSION%"
where curl >nul 2>nul
if errorlevel 1 goto :torch_index_ok
if exist "%TEMP%\pt_index.html" del "%TEMP%\pt_index.html"
curl -s --max-time 25 "%PT_INDEX%/torch/" -o "%TEMP%\pt_index.html"
if errorlevel 1 goto :torch_index_ok
if not exist "%TEMP%\pt_index.html" goto :torch_index_ok
for %%F in ("%TEMP%\pt_index.html") do if %%~zF LSS 1000 goto :torch_index_ok
findstr /r /c:"torch-%TORCH_VERSION%.*%CUDA_VERSION%-cp312-cp312-win_amd64" "%TEMP%\pt_index.html" >nul
if not errorlevel 1 goto :torch_index_ok
echo ERREUR : l'index PyTorch ne propose pas torch %TORCH_VERSION% pour %CUDA_VERSION% ^(Windows, Python 3.12^).
echo   Choisissez une autre pile, ou ouvrez un ticket : cette pile n'est plus installable telle quelle.
pause
exit /b 1
:torch_index_ok

REM --extra-index-url, pas --index-url : l'index CUDA ne publie pas toujours les dependances
REM annexes ^(defaut connu de l'index cu130 : pytorch/pytorch#172926^) ; uv complete alors via PyPI.
uv pip install torch==%TORCH_VERSION% torchvision --extra-index-url %PT_INDEX%
if errorlevel 1 (
    echo ERREUR : l'installation de PyTorch a echoue.
    pause
    exit /b 1
)
REM torchaudio et torchcodec ne declarent aucune dependance vers torch : sans risque de remplacer
REM la version CUDA ci-dessus. Si l'index CUDA n'a pas cette version pour Windows, repli sur PyPI.
uv pip install torchaudio==%TORCHAUDIO_VERSION% torchcodec --extra-index-url %PT_INDEX%
if errorlevel 1 (
    echo   ATTENTION : torchaudio/torchcodec absents de l'index %CUDA_VERSION% - repli sur PyPI.
    uv pip install torchaudio==%TORCHAUDIO_VERSION% torchcodec
)
REM Controle 1 : torch et torchaudio doivent pouvoir s'importer. Un echec ici n'est PAS une roue CPU.
REM Windows a bloque ces fichiers de facon INTERMITTENTE ^("strategie de controle d'application"^) :
REM refuse a un essai, accepte quelques instants plus tard ^(constate sur torchaudio, puis sur torch._C
REM juste apres la creation du venv^). On reessaie donc quelques fois avant de conclure a un echec.
set "TORCH_TRY=0"
:torch_try
.venv\Scripts\python.exe -c "import torch, torchaudio" >nul 2>"%TEMP%\torch_check.txt"
if not errorlevel 1 goto :torch_import_ok
set /a TORCH_TRY+=1
if %TORCH_TRY% GEQ 6 goto :torch_blocked
echo   Import de PyTorch refuse ^(essai %TORCH_TRY% sur 6^) - nouvel essai dans 20 secondes...
timeout /t 20 /nobreak >nul
goto :torch_try
:torch_blocked
type "%TEMP%\torch_check.txt"
echo ERREUR : PyTorch est installe mais ne s'importe pas ^(erreur ci-dessus, 6 essais^).
echo   Une strategie de controle d'application ^(Smart App Control, WDAC^) ou un Visual C++
echo   Redistributable manquant sont les causes habituelles. Voir TROUBLESHOOTING.md ^(section 46^).
pause
exit /b 1
:torch_import_ok
REM Controle 2 : torch doit etre la version CUDA, pas la roue CPU de PyPI.
.venv\Scripts\python.exe -c "import sys, torch; print('torch', torch.__version__); sys.exit(0 if '+cu' in torch.__version__ else 1)"
if errorlevel 1 (
    echo ERREUR : PyTorch installe est la version CPU, pas %CUDA_VERSION%. Le GPU ne serait pas utilise.
    pause
    exit /b 1
)
goto :torch_done

:torch_cpu
uv pip install torch==%TORCH_VERSION% torchvision torchaudio==%TORCHAUDIO_VERSION% torchcodec --index-url https://download.pytorch.org/whl/cpu
if errorlevel 1 (
    echo ERREUR : l'installation de PyTorch a echoue.
    pause
    exit /b 1
)
:torch_done

REM === 6. Dependances d'ACE-Step ================================================
echo [6/14] Dependances ACE-Step...
REM nano-vllm en --no-deps : son pyproject epingle une roue flash-attn Windows cu128 / torch 2.7.1 /
REM Python 3.11 ^(inutilisable ici^). Ses autres dependances ^(torch, transformers, xxhash^) sont
REM installees explicitement plus bas.
uv pip install -e ACE-Step-1.5/acestep/third_parts/nano-vllm/ --no-deps

REM Triton pour torch.compile + graphes CUDA ^(inutile sur CPU^).
if "%CUDA_VERSION%"=="cpu" goto :triton_done
echo Installation de Triton pour torch.compile...
uv pip install "triton-windows%TRITON_SPEC%"
REM Les distributions Python de uv incluent deja les en-tetes de developpement ; cette etape
REM ne devrait normalement plus se declencher, gardee par securite.
REM Chemin reel des en-tetes : demande a Python ^(un venv uv n'a pas de dossier Include^).
.venv\Scripts\python.exe -c "import sysconfig,os,sys; sys.exit(0 if os.path.exists(os.path.join(sysconfig.get_paths()['include'],'Python.h')) else 1)" >nul 2>&1
if not errorlevel 1 goto :triton_done
echo Installation des en-tetes Python pour Triton...
for /f "tokens=*" %%v in ('.venv\Scripts\python.exe -c "import sys; print(sys.version.split()[0])"') do set "PY_VER=%%v"
powershell -Command "& {[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://www.python.org/ftp/python/!PY_VER!/amd64/dev.msi' -OutFile 'downloads\pydev.msi'}"
if not exist "downloads\pydev.msi" goto :triton_done
msiexec /a "downloads\pydev.msi" /qn TARGETDIR="%SCRIPT_DIR%downloads\pydev_extract"
if not exist ".venv\Include" mkdir ".venv\Include"
if not exist ".venv\libs" mkdir ".venv\libs"
xcopy /E /Y "downloads\pydev_extract\include\*" ".venv\Include\" >nul 2>&1
xcopy /E /Y "downloads\pydev_extract\libs\*" ".venv\libs\" >nul 2>&1
if exist "downloads\pydev_extract" rmdir /s /q "downloads\pydev_extract"
echo [OK] En-tetes Python installes
:triton_done
REM Cet echo semble superflu mais NE PAS LE RETIRER : l'ajout de ce type d'echo a fait disparaitre,
REM de facon reproductible, un plantage intermittent ^("... etait inattendu.", cmd.exe pur^) survenant
REM a cet endroit precis du script d'origine. Cause exacte non confirmee ; correctif empirique.
echo   [OK] Environnement pret

REM --- flash-attn ---------------------------------------------------------------
if "%FLASH_OK%"=="0" goto :flash_skip
echo Installation de flash-attn ^(roue precompilee, aucune compilation^)...
uv pip install "%FLASH_URL%"
if errorlevel 1 goto :flash_failed
REM Verification FONCTIONNELLE sur le GPU reel : une roue qui ne contient pas l'architecture de la
REM carte s'importe sans erreur, puis echoue au premier vrai appel ^("no kernel image is available"^).
.venv\Scripts\python.exe -c "import torch; from flash_attn import flash_attn_func; q=torch.randn(1,128,8,64,device='cuda',dtype=torch.bfloat16); flash_attn_func(q,q,q); torch.cuda.synchronize()" >nul
if errorlevel 1 goto :flash_notrun
echo   OK - flash-attn s'execute sur ce GPU ^(test fonctionnel^).
goto :flash_done
:flash_failed
echo   ATTENTION : la roue flash-attn n'a pas pu etre installee. SDPA prendra le relais ^(fonctionnel,
echo   juste sans cette acceleration^).
goto :flash_done
:flash_notrun
echo   ATTENTION : la roue flash-attn ne s'execute pas sur ce GPU ^(architecture absente ?^).
echo   flash-attn est retire ; SDPA prendra le relais ^(fonctionnel, juste sans cette acceleration^).
uv pip uninstall flash-attn
goto :flash_done
:flash_skip
echo flash-attn ignore : %FLASH_NOTE%.
echo   SDPA continuera de fonctionner normalement, juste sans cette acceleration.
:flash_done

REM torch, torchaudio et torchcodec sont deja installes plus haut : volontairement absents de cette
REM liste. diffusers est EGALEMENT absent d'ici - installe separement en dessous avec --no-deps.
REM huggingface-hub inferieur a 1.0 EXPLICITE : ACE-Step-1.5 refuse de demarrer avec huggingface-hub 1.0 ou plus
REM ^(ImportError : huggingface-hub 0.34.0 a 1.0 exclu is required^), comme sous Linux.
uv pip install "transformers>=4.51.0,<4.58.0" "huggingface-hub<1.0" gradio==6.2.0 matplotlib scipy soundfile loguru einops accelerate fastapi diskcache "uvicorn[standard]" numba vector-quantize-pytorch "torchao>=0.17.0,<0.18.0" toml peft modelscope tensorboard typer-slim hf_transfer hf_xet lightning lycoris-lora safetensors xxhash "pytorch-wavelets>=1.3.0" "pywavelets>=1.9.0" "bitsandbytes>=0.50.0"

REM diffusers==0.40.0 en --no-deps, DELIBEREMENT ^(voir install.sh^) : ses metadonnees exigent
REM huggingface-hub 1.23.0 ou plus, incompatible avec huggingface-hub inferieur a 1.0 ci-dessus selon le resolveur.
REM En pratique diffusers 0.40.0 fonctionne avec huggingface-hub 0.36.x pour l'usage d'ACE-Step
REM ^(seul AutoencoderOobleck est utilise^) ; confirme sous Linux. diffusers 0.41.0 NE doit PAS
REM etre utilise ici : il echoue a l'import avec huggingface-hub 0.36.x. Ses autres dependances
REM ^(Pillow, safetensors, filelock, numpy, regex...^) sont deja couvertes par les lignes ci-dessus.
uv pip install "diffusers==0.40.0" --no-deps

REM Installer ace-step en dernier ^(toutes ses dependances sont deja satisfaites^).
uv pip install -e ACE-Step-1.5/ --no-deps

REM Whisper ^(paroles reelles des audios importes, fenetre d analyse^). Installe en dernier pour ne pas
REM modifier les versions deja resolues ; non bloquant : sans Whisper, paroles estimees par le modele seulement.
uv pip install openai-whisper
if errorlevel 1 echo [AVERTISSEMENT] Whisper non installe : paroles estimees par le modele seulement.

REM === 7. Correctifs ============================================================
echo [7/14] Correctif pytorch_wavelets ^(pkg_resources^)...
REM pytorch_wavelets ^(dependance de DCW^) utilise encore "from pkg_resources import resource_stream".
REM Depuis setuptools 82, pkg_resources n'est plus fourni par defaut et l'import echoue
REM silencieusement - DCW se desactive alors proprement. Correctif chirurgical du fichier
REM lui-meme, sans toucher a setuptools. Idempotent.
if exist "patch-pytorch-wavelets.py" (
    .venv\Scripts\python.exe patch-pytorch-wavelets.py
) else (
    echo   ATTENTION : patch-pytorch-wavelets.py introuvable, correctif ignore.
    echo   DCW restera desactive ^(repli automatique, pas de plantage^).
)

REM studio_log_filters.py - filtre quelques messages connus et sans consequence ^(torchao, diffusers,
REM transformers : voir la docstring du fichier^) et passe le niveau loguru par defaut a INFO
REM ^(LOGURU_LEVEL=DEBUG pour le mode verbeux^). Charge par un .pth ^(studio_log_filters.pth^), comme sous Linux.
REM Copie dans le site-packages : apres une modification, recopier le fichier a la main.
if not exist "studio_log_filters.py" goto :site_missing
for /f "delims=" %%p in ('.venv\Scripts\python.exe -c "import site; print(site.getsitepackages()[-1])"') do set "SITE_PACKAGES=%%p"
copy /Y "studio_log_filters.py" "!SITE_PACKAGES!\studio_log_filters.py" >nul
> "!SITE_PACKAGES!\studio_log_filters.pth" echo import studio_log_filters
REM Les anciens installeurs deposaient ce code sous le nom sitecustomize.py : on retire ce fichier-la seulement.
if exist "!SITE_PACKAGES!\sitecustomize.py" findstr /C:"avant meme le code d'ACE-Step-1.5" "!SITE_PACKAGES!\sitecustomize.py" >nul && del "!SITE_PACKAGES!\sitecustomize.py"
echo   [OK] filtres de messages deployes : !SITE_PACKAGES!\studio_log_filters.pth
goto :site_done
:site_missing
echo   ATTENTION : studio_log_filters.py introuvable, messages connus non filtres.
:site_done

REM === 8. Node.js ===============================================================
if exist "node\node.exe" (
    echo [OK] Node.js deja installe
) else (
    echo [8/14] Telechargement de Node.js 22 LTS...
    if not exist "node" mkdir node
    powershell -Command "& {[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://nodejs.org/dist/v22.18.0/node-v22.18.0-win-x64.zip' -OutFile 'downloads\node.zip'}"
    if not exist "downloads\node.zip" (
        echo ERREUR : echec du telechargement de Node.js.
        pause
        exit /b 1
    )
    powershell -Command "& {Expand-Archive -Path 'downloads\node.zip' -DestinationPath 'downloads\node-extract' -Force}"
    powershell -Command "& {Get-ChildItem 'downloads\node-extract\node-*\*' | Move-Item -Destination 'node' -Force}"
    if exist "downloads\node-extract" rmdir /s /q "downloads\node-extract"
    echo [OK] Node.js 22 LTS installe
)

REM === 9. Dependances npm =======================================================
echo [9/14] Dependances npm ^(frontend et serveur^)...
set "PATH=%SCRIPT_DIR%node;%PATH%"

echo   Frontend...
cd /d "%SCRIPT_DIR%"
cd app
call "%SCRIPT_DIR%node\npm.cmd" install

echo   Serveur...
cd /d "%SCRIPT_DIR%"
cd app\server
call "%SCRIPT_DIR%node\npm.cmd" install

REM === 10. Compilation du frontend ==============================================
echo [10/14] Compilation du frontend...
cd /d "%SCRIPT_DIR%"
cd app
call "%SCRIPT_DIR%node\npx.cmd" vite build
cd /d "%SCRIPT_DIR%"
REM Version du depot compilee : run.bat recompile l'interface quand elle change ^(voir TROUBLESHOOTING.md^).
where git >nul 2>&1
if not errorlevel 1 if exist "app\dist\index.html" for /f %%h in ('git rev-parse HEAD 2^>nul') do >"app\dist\.build-commit" echo %%h

REM === 11. FFmpeg ===============================================================
cd /d "%SCRIPT_DIR%"
echo [11/14] FFmpeg ^(rendu video^)...
REM FFmpeg en version PARTAGEE ^(avec ses DLL^) : torchcodec ^(donc torchaudio.save, donc l'export MP3^)
REM charge les DLL d'FFmpeg. La version statique ^(ffmpeg.exe seul^) installee auparavant les omettait :
REM "Could not load libtorchcodec" a la premiere generation en MP3. Branche 8.1 ^(torchcodec gere 4 a 9^),
REM repli sur la version de developpement. Une ancienne installation statique est remplacee.
if exist "ffmpeg\ffmpeg.exe" if exist "ffmpeg\avcodec-*.dll" goto :ffmpeg_done
echo Telechargement de FFmpeg ^(version avec DLL^)...
if not exist "ffmpeg" mkdir ffmpeg
if exist "downloads\ffmpeg-shared.zip" del "downloads\ffmpeg-shared.zip"
powershell -Command "& {[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-win64-gpl-shared-8.1.zip' -OutFile 'downloads\ffmpeg-shared.zip'}"
if exist "downloads\ffmpeg-shared.zip" goto :ffmpeg_extract
echo   Branche 8.1 indisponible - essai avec la version de developpement...
powershell -Command "& {[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl-shared.zip' -OutFile 'downloads\ffmpeg-shared.zip'}"
if exist "downloads\ffmpeg-shared.zip" goto :ffmpeg_extract
echo ATTENTION : FFmpeg n'a pas pu etre telecharge. Le rendu video et l'export MP3 ne fonctionneront pas.
goto :ffmpeg_done
:ffmpeg_extract
powershell -Command "& {Expand-Archive -Path 'downloads\ffmpeg-shared.zip' -DestinationPath 'downloads\ffmpeg-extract' -Force}"
REM Copie simple de bin\* ^(exe ET dll^) : la forme precedente ^(Get-ChildItem -Include^) n'a rien copie
REM chez l'utilisateur, sans message ; celle-ci a ete verifiee a la main sur sa machine.
powershell -Command "& {Copy-Item 'downloads\ffmpeg-extract\*\bin\*' 'ffmpeg' -Force}"
if exist "downloads\ffmpeg-extract" rmdir /s /q "downloads\ffmpeg-extract"
if exist "ffmpeg\avcodec-*.dll" goto :ffmpeg_ok
echo ATTENTION : les DLL d'FFmpeg n'ont pas ete copiees dans ffmpeg. L'export MP3 echouera.
echo   Copie manuelle : voir TROUBLESHOOTING.md, section 47.
goto :ffmpeg_done
:ffmpeg_ok
echo [OK] FFmpeg installe
:ffmpeg_done

REM Verification de l'export MP3 ^(INFORMATIVE^) : le moteur encode le MP3 avec libsndfile ^(soundfile^), sans
REM programme externe. On ecrit reellement 0,1 seconde en MP3 avec ce meme chemin.
set "MP3_TRY=0"
:mp3_try
.venv\Scripts\python.exe -c "import numpy as np, soundfile as sf, os, tempfile; p = os.path.join(tempfile.gettempdir(), 'ace_mp3_check.mp3'); assert 'MP3' in sf.available_formats(); sf.write(p, np.zeros((4800, 2), dtype='float32'), 48000, format='MP3'); assert os.path.getsize(p) > 0" >nul 2>"%TEMP%\mp3_check.txt"
if not errorlevel 1 goto :mp3_ok
set /a MP3_TRY+=1
if %MP3_TRY% GEQ 4 goto :mp3_failed
echo   Encodage MP3 refuse ^(essai %MP3_TRY% sur 4^) - nouvel essai dans 20 secondes...
timeout /t 20 /nobreak >nul
goto :mp3_try
:mp3_failed
echo   ATTENTION : l'encodage MP3 par soundfile echoue ^(derniere ligne de l'erreur ci-dessous^).
echo   Le moteur essaiera ffmpeg en secours ; sinon utilisez FLAC ou WAV. Voir TROUBLESHOOTING.md.
powershell -Command "& {Get-Content '%TEMP%\mp3_check.txt' -Tail 2}"
goto :tc_done
:mp3_ok
echo   OK - l'export MP3 fonctionne.
:tc_done

REM === 12. Migration de la base =================================================
REM La colonne 'kind' est ajoutee directement dans app/server/src/db/migrate.ts, qui s'execute
REM automatiquement a CHAQUE demarrage de run.bat - rien a faire ici.
echo [12/14] Migration de la base de donnees...
echo   Geree automatiquement au demarrage de run.bat - rien a faire ici.

REM === 13. Environnement basic-pitch ============================================
REM Environnement SEPARE - CONFIRME NECESSAIRE : basic-pitch entraine tensorflow^<2.15.1, qui force
REM tensorboard^<2.16, or ace-step exige tensorboard>=2.20.0. Un second venv evite ce conflit
REM ^(meme logique que sous Linux^). Python 3.11 ici : tensorflow n'a pas de roue pour 3.12.
echo [13/14] Environnement basic-pitch ^(conversion MIDI^)...
REM Un environnement existant n'est conserve que s'il FONCTIONNE ^(un numpy 2 installe par erreur le
REM rendait inutilisable, et l'ancien test "le python.exe existe" le gardait indefiniment^).
if not exist ".venv-basicpitch\Scripts\python.exe" goto :bp_create
.venv-basicpitch\Scripts\python.exe -c "from basic_pitch.inference import predict" >nul 2>nul
if errorlevel 1 goto :bp_recreate
echo [OK] Environnement basic-pitch deja installe
goto :basicpitch_done
:bp_recreate
echo   Environnement basic-pitch inutilisable - recreation...
rmdir /s /q ".venv-basicpitch"
:bp_create
uv venv --python 3.11 .venv-basicpitch
if errorlevel 1 (
    echo   ATTENTION : creation de l'environnement basic-pitch impossible - la conversion MIDI ne fonctionnera pas.
    goto :basicpitch_done
)
REM Version figee : sans elle, pip peut reculer vers d'anciennes versions de basic-pitch qui exigent
REM un numpy anterieur a 1.24. setuptools^<81 EXPLICITE : depuis setuptools 82, pkg_resources n'est
REM plus fourni par defaut, et resampy ^(dependance de basic-pitch^) l'importe sans le declarer.
uv pip install --python .venv-basicpitch\Scripts\python.exe "setuptools<81"
REM numpy^<2 EXPLICITE : le resolveur de uv choisit tensorflow 2.14 avec numpy 2.x ^(import impossible :
REM "module compiled using NumPy 1.x cannot be run in NumPy 2"^) ; avec numpy^<2 il retient tensorflow 2.15.
uv pip install --python .venv-basicpitch\Scripts\python.exe "numpy<2" "basic-pitch[onnx]==0.4.0"
.venv-basicpitch\Scripts\python.exe -c "from basic_pitch.inference import predict"
if errorlevel 1 (
    echo   ATTENTION : basic-pitch ne s'importe pas correctement ^(voir l'erreur ci-dessus^). La conversion MIDI ne fonctionnera pas.
) else (
    echo [OK] Environnement basic-pitch installe
)
:basicpitch_done

REM === 14. Environnement Demucs ^(separation de stems^) ===========================
REM Environnement SEPARE comme basic-pitch ^(meme logique que app/server/setup-demucs-venv.sh sous Linux^).
REM Memes versions figees que sous Linux, sans torchaudio : demucs.api ne l'utilise pas ^(il n'est requis que
REM par ses modules d'entrainement^). Sous Windows, le torch de PyPI est la version CPU, ce qui suffit ici.
echo [14/14] Environnement Demucs ^(separation de stems^)...
REM Meme dossier de cache Hugging Face que run.bat ^(HF_HOME^) : sinon le modele pre-telecharge ici
REM est ignore au demarrage et re-telecharge a la premiere separation.
set "HF_HOME=%~dp0models"
if not exist ".venv-demucs\Scripts\python.exe" goto :dm_create
.venv-demucs\Scripts\python.exe -c "import demucs.api" >nul 2>nul
if errorlevel 1 goto :dm_recreate
echo [OK] Environnement Demucs deja installe
goto :demucs_done
:dm_recreate
echo   Environnement Demucs inutilisable - recreation...
rmdir /s /q ".venv-demucs"
:dm_create
uv venv --python 3.11 .venv-demucs
if errorlevel 1 (
    echo   ATTENTION : creation de l'environnement Demucs impossible - la separation de stems ne fonctionnera pas.
    goto :demucs_done
)
uv pip install --python .venv-demucs\Scripts\python.exe "torch==2.14.1" "demucs==4.1.0" "numpy==2.4.6"
REM Smart App Control peut refuser un fichier non signe puis l'accepter plus tard : on reessaie ^(voir TROUBLESHOOTING.md^).
set "DM_TRY=0"
:dm_try
.venv-demucs\Scripts\python.exe -c "import demucs.api" >nul 2>"%TEMP%\dm_check.txt"
if not errorlevel 1 goto :dm_ok
set /a DM_TRY+=1
if %DM_TRY% GEQ 6 goto :dm_failed
echo   Import de Demucs refuse ^(essai %DM_TRY% sur 6^) - nouvel essai dans 20 secondes...
timeout /t 20 /nobreak >nul
goto :dm_try
:dm_failed
echo   ATTENTION : Demucs ne s'importe pas ^(derniere ligne de l'erreur ci-dessous^). La separation de stems ne fonctionnera pas.
powershell -Command "& {Get-Content '%TEMP%\dm_check.txt' -Tail 2}"
goto :demucs_done
:dm_ok
echo [OK] Demucs installe
echo   Telechargement du modele de separation ^(6 stems, quelques minutes^)...
.venv-demucs\Scripts\python.exe -c "from demucs.pretrained import get_model; get_model('htdemucs_6s')"
if errorlevel 1 echo   ATTENTION : modele non telecharge ^(il le sera au premier usage^).
:demucs_done

REM === Controle final : fichiers natifs et Smart App Control ====================
REM Windows peut refuser TEMPORAIREMENT le chargement d'un fichier natif non signe, puis l'accepter quelques
REM minutes plus tard ^(TROUBLESHOOTING.md, section 46^). On charge ici les modules sensibles de chaque
REM environnement et on reessaie, pour que le premier lancement de run.bat ne tombe pas sur un refus.
if not defined SAC_MAX set "SAC_MAX=12"
echo.
echo Controle final des fichiers natifs ^(jusqu'a %SAC_MAX% essais, 30 secondes d'intervalle^)...
set "SAC_TRY=0"
:sac_try
set "SAC_BAD=0"
.venv\Scripts\python.exe check-imports.py main 2>nul
if errorlevel 1 set "SAC_BAD=1"
if exist ".venv-basicpitch\Scripts\python.exe" (
    .venv-basicpitch\Scripts\python.exe check-imports.py basicpitch 2>nul
    if errorlevel 1 set "SAC_BAD=1"
)
if exist ".venv-demucs\Scripts\python.exe" (
    .venv-demucs\Scripts\python.exe check-imports.py demucs 2>nul
    if errorlevel 1 set "SAC_BAD=1"
)
if exist "ffmpeg\ffmpeg.exe" (
    ffmpeg\ffmpeg.exe -version >nul 2>nul
    if errorlevel 1 (
        echo   [ffmpeg] REFUSE : ffmpeg.exe ne demarre pas ^(rendu video et normalisation indisponibles pour l'instant^)
        set "SAC_BAD=1"
    )
)
REM ffprobe.exe est un fichier distinct : Windows peut l'accepter plus tard que ffmpeg.exe. Sans lui, la duree des morceaux
REM est lue par Python ^(secours du serveur^), mais le controle doit quand meme l'attendre.
if exist "ffmpeg\ffprobe.exe" (
    ffmpeg\ffprobe.exe -version >nul 2>nul
    if errorlevel 1 (
        echo   [ffprobe] REFUSE : ffprobe.exe ne demarre pas
        set "SAC_BAD=1"
    )
)
if "%SAC_BAD%"=="0" goto :sac_ok
set /a SAC_TRY+=1
if %SAC_TRY% GEQ %SAC_MAX% goto :sac_failed
echo   Essai %SAC_TRY% sur %SAC_MAX% - nouvel essai dans 30 secondes...
timeout /t 30 /nobreak >nul
goto :sac_try
:sac_failed
set "SAC_FAILED=1"
echo.
echo   ATTENTION : des fichiers sont toujours refuses ^(liste ci-dessus^). Ce n'est pas une erreur d'installation :
echo   Smart App Control les accepte en general au bout de quelques minutes a une demi-heure.
echo   Lancez simplement run.bat : il attend automatiquement ^(20 minutes au plus^) que Windows ait fini.
echo   Ne relancez pas install.bat pour cela : il recree .venv et fait repartir l'attente de zero.
echo   Details : TROUBLESHOOTING.md, section 46.
echo en attente> sac_pending.txt
goto :sac_done
:sac_ok
echo [OK] Tous les fichiers natifs se chargent.
if exist "sac_pending.txt" del "sac_pending.txt"
:sac_done

REM === Configuration GPU enregistree ===========================================
echo %CUDA_VERSION%> cuda_version.txt

REM === Profil materiel : modele par defaut selon la VRAM =======================
REM Ecrit hardware_profile.env, lu par run.bat ^(meme logique que install.sh^).
echo.
.venv\Scripts\python.exe write-hardware-profile.py
if errorlevel 1 echo   ATTENTION : le profil materiel n'a pas ete ecrit ^(run.bat le refera au prochain lancement^).

REM === Carte de 4 a 8 Go : choix du mode normal ou flux ========================
REM Le choix deja fait ^(reinstallation^) est repris comme suggestion et garde par write-hardware-profile.py.
.venv\Scripts\python.exe write-hardware-profile.py --can-choose
if errorlevel 1 goto :hw_choice_done
set "HW_PREV="
for /f "delims=" %%p in ('.venv\Scripts\python.exe write-hardware-profile.py --get-mode') do set "HW_PREV=%%p"
set "HW_CHOICE_DEFAULT=1"
if /i "%HW_PREV%"=="stream" set "HW_CHOICE_DEFAULT=2"
echo.
echo Mode de generation pour cette carte ^(4 a 8 Go^) :
echo   1. Normal
echo        Le modele est comprime ^(int8^) et charge sur la carte a chaque generation, puis decharge.
echo        Mesure sur une RTX 5060 8 Go, modele XL Turbo, morceau de 3 minutes : environ 3 a 7 s de calcul du DiT, plus
echo        4 a 6 s de chargement / dechargement. Aucun reglage. Les morceaux longs peuvent manquer de memoire carte
echo        pendant le LRC.
echo   2. Flux
echo        Le moteur reste sur le processeur et fait passer le modele par la carte, bloc par bloc ; les blocs qui tiennent
echo        restent sur la carte. Pas de compression : calcul en bf16, comme le modele publie. Mesure sur la meme carte,
echo        meme duree : environ 9 s pour le DiT XL. Demande environ 10 Go de RAM libre en plus ^(32 Go de RAM conseilles^).
echo        LoRA possible. Les pochettes IA exigent 6 Go de carte ou plus.
echo   Les deux modes se changent plus tard sans reinstaller : run.bat --mode normal  ou  run.bat --mode flux
set "HW_CHOICE="
set /p "HW_CHOICE=Votre choix [%HW_CHOICE_DEFAULT%] : "
if "%HW_CHOICE%"=="" set "HW_CHOICE=%HW_CHOICE_DEFAULT%"
if "%HW_CHOICE%"=="2" (
    .venv\Scripts\python.exe write-hardware-profile.py --set-mode flux
) else (
    .venv\Scripts\python.exe write-hardware-profile.py --set-mode normal
)
:hw_choice_done

REM === Raccourcis : Bureau et menu Demarrer, avec l'icone ======================
REM Un echec ici ne doit jamais faire echouer l'installation.
if exist "create-shortcut.bat" (
    echo.
    call create-shortcut.bat
    if errorlevel 1 echo   Raccourci non cree ^(relancer create-shortcut.bat plus tard^).
)

echo.
echo ========================================
if defined SAC_FAILED (
    echo   Installation terminee, AVEC DES AVERTISSEMENTS ^(voir ci-dessus^).
) else (
    echo   Installation terminee avec succes.
)
echo.
echo   Demarrage : run.bat ^(ou le raccourci "ACE-Step Studio" du Bureau et du menu Demarrer^)
echo   Les modeles se telechargent au premier lancement.
echo ========================================
pause
exit /b 0

REM === Sous-programme : confirmer une poursuite malgre un avertissement ==========
:ask_continue
set "REPLY="
set /p "REPLY=Continuer malgre tout ? [o/N] "
if /i "%REPLY%"=="o" exit /b 0
exit /b 1
