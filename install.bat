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
echo [1/13] Creation des repertoires de travail...
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
echo [2/13] Materiel
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
echo [3/13] Installation de uv...
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
echo [4/13] Environnement virtuel Python 3.12...
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

REM Outils de build ^(pas de cmake ni ninja : aucune compilation sous Windows, roues precompilees^).
uv pip install hatchling editables setuptools wheel

REM === 5. PyTorch ===============================================================
echo [5/13] PyTorch %TORCH_VERSION% ^(%CUDA_NAME%^)...
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
REM Controle : torch doit etre la version CUDA, pas la roue CPU de PyPI.
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
echo [6/13] Dependances ACE-Step...
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
if exist ".venv\Include\Python.h" goto :triton_done
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

REM === 7. Correctifs ============================================================
echo [7/13] Correctif pytorch_wavelets ^(pkg_resources^)...
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

REM sitecustomize.py - filtre un FutureWarning generique de diffusers ^(AutoencoderOobleck^),
REM sans consequence mais visible a chaque lancement. Mecanisme standard Python ^(module site^).
if not exist "sitecustomize.py" goto :site_missing
for /f "delims=" %%p in ('.venv\Scripts\python.exe -c "import site; print(site.getsitepackages()[-1])"') do set "SITE_PACKAGES=%%p"
copy /Y "sitecustomize.py" "!SITE_PACKAGES!\sitecustomize.py" >nul
echo   [OK] sitecustomize.py deploye : !SITE_PACKAGES!\sitecustomize.py
goto :site_done
:site_missing
echo   ATTENTION : sitecustomize.py introuvable, avertissement diffusers non filtre.
:site_done

REM === 8. Node.js ===============================================================
if exist "node\node.exe" (
    echo [OK] Node.js deja installe
) else (
    echo [8/13] Telechargement de Node.js 22 LTS...
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
echo [9/13] Dependances npm ^(frontend et serveur^)...
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
echo [10/13] Compilation du frontend...
cd /d "%SCRIPT_DIR%"
cd app
call "%SCRIPT_DIR%node\npx.cmd" vite build

REM === 11. FFmpeg ===============================================================
cd /d "%SCRIPT_DIR%"
echo [11/13] FFmpeg ^(rendu video^)...
if exist "ffmpeg\ffmpeg.exe" goto :ffmpeg_done
echo Telechargement de FFmpeg...
if not exist "ffmpeg" mkdir ffmpeg
powershell -Command "& {[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip' -OutFile 'downloads\ffmpeg.zip'}"
if not exist "downloads\ffmpeg.zip" (
    echo ATTENTION : FFmpeg n'a pas pu etre telecharge. Le rendu video ne fonctionnera pas.
    goto :ffmpeg_done
)
powershell -Command "& {Expand-Archive -Path 'downloads\ffmpeg.zip' -DestinationPath 'downloads\ffmpeg-extract' -Force}"
powershell -Command "& {Get-ChildItem 'downloads\ffmpeg-extract\ffmpeg-*\bin\ffmpeg.exe' | Copy-Item -Destination 'ffmpeg\ffmpeg.exe' -Force}"
powershell -Command "& {Get-ChildItem 'downloads\ffmpeg-extract\ffmpeg-*\bin\ffprobe.exe' | Copy-Item -Destination 'ffmpeg\ffprobe.exe' -Force}"
if exist "downloads\ffmpeg-extract" rmdir /s /q "downloads\ffmpeg-extract"
echo [OK] FFmpeg installe
:ffmpeg_done

REM Verification de torchcodec ^(INFORMATIVE^) : mieux vaut le savoir ici qu'au premier fichier audio.
REM Sur l'ancienne pile torch 2.10 / cu130, torchcodec ne chargeait pas ses DLL sous Windows ^(export
REM MP3 casse, bug amont meta-pytorch/torchcodec #1233, #1289, #1006^). Cette pile-ci ^(torch 2.14,
REM torchcodec 0.17^) n'a PAS ete verifiee sous Windows : si le message ci-dessous apparait, utiliser
REM FLAC ou WAV comme format de sortie ^(ils passent par soundfile, jamais par torchcodec^).
if "%CUDA_VERSION%"=="cpu" goto :tc_done
set "PATH=%SCRIPT_DIR%ffmpeg;%PATH%"
.venv\Scripts\python.exe -c "import torchcodec" >nul 2>nul
if errorlevel 1 (
    echo   ATTENTION : torchcodec ne se charge pas. L'export MP3 echouera peut-etre :
    echo   utilisez FLAC ou WAV comme format de sortie. Voir TROUBLESHOOTING.md.
) else (
    echo   OK - torchcodec se charge correctement.
)
:tc_done

REM === 12. Migration de la base =================================================
REM La colonne 'kind' est ajoutee directement dans app/server/src/db/migrate.ts, qui s'execute
REM automatiquement a CHAQUE demarrage de run.bat - rien a faire ici.
echo [12/13] Migration de la base de donnees...
echo   Geree automatiquement au demarrage de run.bat - rien a faire ici.

REM === 13. Environnement basic-pitch ============================================
REM Environnement SEPARE - CONFIRME NECESSAIRE : basic-pitch entraine tensorflow^<2.15.1, qui force
REM tensorboard^<2.16, or ace-step exige tensorboard>=2.20.0. Un second venv evite ce conflit
REM ^(meme logique que sous Linux^). Python 3.11 ici : tensorflow n'a pas de roue pour 3.12.
echo [13/13] Environnement basic-pitch ^(conversion MIDI^)...
if exist ".venv-basicpitch\Scripts\python.exe" (
    echo [OK] Environnement basic-pitch deja installe
    goto :basicpitch_done
)
uv venv --python 3.11 .venv-basicpitch
if errorlevel 1 (
    echo   ATTENTION : creation de l'environnement basic-pitch impossible - la conversion MIDI ne fonctionnera pas.
    goto :basicpitch_done
)
REM Version figee : sans elle, pip peut reculer vers d'anciennes versions de basic-pitch qui exigent
REM un numpy anterieur a 1.24. setuptools^<81 EXPLICITE : depuis setuptools 82, pkg_resources n'est
REM plus fourni par defaut, et resampy ^(dependance de basic-pitch^) l'importe sans le declarer.
uv pip install --python .venv-basicpitch\Scripts\python.exe "setuptools<81"
uv pip install --python .venv-basicpitch\Scripts\python.exe "basic-pitch[onnx]==0.4.0"
.venv-basicpitch\Scripts\python.exe -c "from basic_pitch.inference import predict"
if errorlevel 1 (
    echo   ATTENTION : basic-pitch ne s'importe pas correctement ^(voir l'erreur ci-dessus^). La conversion MIDI ne fonctionnera pas.
) else (
    echo [OK] Environnement basic-pitch installe
)
:basicpitch_done

REM === Configuration GPU enregistree ===========================================
echo %CUDA_VERSION%> cuda_version.txt

echo.
echo ========================================
echo   Installation terminee avec succes.
echo.
echo   Demarrage : run.bat
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
