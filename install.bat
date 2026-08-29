@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

echo ========================================
echo   ACE-Step Studio - Install
echo ========================================

set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"
set "TEMP=%SCRIPT_DIR%temp"
set "TMP=%SCRIPT_DIR%temp"

REM === Create directories ===
if not exist "downloads" mkdir downloads
if not exist "temp" mkdir temp
if not exist "models" mkdir models
if not exist "cache" mkdir cache
if not exist "app\data" mkdir "app\data"
if not exist "app\server\public\audio" mkdir "app\server\public\audio"

REM ============================================================
REM  Step 1: GPU Selection
REM ============================================================
echo.
echo Select your GPU:
echo.
echo   1. NVIDIA GTX 10xx (Pascal)
echo   2. NVIDIA RTX 20xx (Turing)
echo   3. NVIDIA RTX 30xx (Ampere)
echo   4. NVIDIA RTX 40xx (Ada Lovelace)
echo   5. NVIDIA RTX 50xx (Blackwell)
echo   6. CPU only (no GPU)
echo.
set /p GPU_CHOICE="Enter number (1-6): "

if "%GPU_CHOICE%"=="1" goto :gpu_10xx
if "%GPU_CHOICE%"=="2" goto :gpu_20xx
if "%GPU_CHOICE%"=="3" goto :gpu_30xx
if "%GPU_CHOICE%"=="4" goto :gpu_40xx
if "%GPU_CHOICE%"=="5" goto :gpu_50xx
if "%GPU_CHOICE%"=="6" goto :gpu_cpu
echo Invalid choice!
pause
exit /b 1

:gpu_10xx
set "CUDA_VERSION=cu118"
set "CUDA_NAME=CUDA 11.8 (GTX 10xx)"
set "TORCH_VERSION=2.7.1"
set "TORCHAUDIO_VERSION=2.7.1"
goto :gpu_done

:gpu_20xx
set "CUDA_VERSION=cu126"
set "CUDA_NAME=CUDA 12.6 (RTX 20xx)"
set "TORCH_VERSION=2.7.1"
set "TORCHAUDIO_VERSION=2.7.1"
goto :gpu_done

:gpu_30xx
set "CUDA_VERSION=cu126"
set "CUDA_NAME=CUDA 12.6 (RTX 30xx)"
set "TORCH_VERSION=2.7.1"
set "TORCHAUDIO_VERSION=2.7.1"
goto :gpu_done

:gpu_40xx
set "CUDA_VERSION=cu128"
set "CUDA_NAME=CUDA 12.8 (RTX 40xx)"
set "TORCH_VERSION=2.7.1"
set "TORCHAUDIO_VERSION=2.7.1"
goto :gpu_done

:gpu_50xx
set "CUDA_VERSION=cu128"
set "CUDA_NAME=CUDA 12.8 (RTX 50xx)"
set "TORCH_VERSION=2.7.1"
set "TORCHAUDIO_VERSION=2.7.1"
goto :gpu_done

:gpu_cpu
set "CUDA_VERSION=cpu"
set "CUDA_NAME=CPU only"
set "TORCH_VERSION=2.7.1"
set "TORCHAUDIO_VERSION=2.7.1"
goto :gpu_done

:gpu_done
echo.
echo Selected: %CUDA_NAME%
echo.

REM ============================================================
REM  Step 2: uv (remplace le zip Python embarque + get-pip.py)
REM ============================================================
REM uv gere lui-meme le telechargement et la mise en place de Python - plus
REM besoin de zip embarque ni de correctif manuel du fichier _pth. Meme
REM outil que sous Linux (install.sh), pour une approche homogene entre les
REM deux plateformes.
REM
REM Point d'attention Windows specifique : l'installeur uv modifie le PATH
REM utilisateur PERSISTANT, mais cette modification ne s'applique qu'aux
REM FUTURES fenetres cmd - jamais a la session en cours qui vient de le
REM lancer. On ajoute donc explicitement son dossier d'installation au PATH
REM de cette session, sans compter sur un rafraichissement automatique.
where uv >nul 2>nul
if errorlevel 1 (
    if exist "%USERPROFILE%\.local\bin\uv.exe" (
        echo [OK] uv already installed
    ) else (
        echo [1/10] Installing uv...
        powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
        if not exist "%USERPROFILE%\.local\bin\uv.exe" (
            echo ERROR: uv installation failed!
            pause
            exit /b 1
        )
        echo [OK] uv installed
    )
    set "PATH=%USERPROFILE%\.local\bin;%PATH%"
) else (
    echo [OK] uv already installed
)

REM ============================================================
REM  Step 3: Python 3.11 virtual environment
REM ============================================================
if exist ".venv\Scripts\python.exe" (
    echo [OK] Virtual environment already exists
) else (
    echo [2/10] Creating Python 3.11 virtual environment...
    uv venv --python 3.11 .venv
    if errorlevel 1 (
        echo ERROR: Failed to create virtual environment!
        pause
        exit /b 1
    )
    echo [OK] Virtual environment created
)
call .venv\Scripts\activate.bat

REM ============================================================
REM  Step 4: PyTorch
REM ============================================================
echo [3/10] Installing PyTorch %TORCH_VERSION% (%CUDA_NAME%)...
if "%CUDA_VERSION%"=="cpu" (
    uv pip install torch==%TORCH_VERSION% torchaudio==%TORCHAUDIO_VERSION% torchvision --index-url https://download.pytorch.org/whl/cpu
) else (
    uv pip install torch==%TORCH_VERSION% torchaudio==%TORCHAUDIO_VERSION% torchvision --index-url https://download.pytorch.org/whl/%CUDA_VERSION%
)

REM ============================================================
REM  Step 5: ACE-Step dependencies
REM ============================================================
echo [4/10] Installing ACE-Step dependencies...
uv pip install hatchling editables
REM Install nano-vllm first (local package, needed before ace-step)
uv pip install -e ACE-Step-1.5/acestep/third_parts/nano-vllm/
REM Install all deps before ace-step to avoid resolver warnings
REM torchao fixe a 0.13.0 (pas la fourchette >=0.16.0 d'origine, presente
REM aussi dans le fichier upstream avant tout correctif) : torchao 0.16.0
REM attend torch 2.10.0 selon sa propre table de compatibilite officielle
REM (pytorch/ao#2919), pas notre torch==2.7.1 fixe plus haut - d'ou
REM l'avertissement "Skipping import of cpp extensions due to incompatible
REM torch version", deja signale separement sur le depot ACE-Step-1.5
REM lui-meme (issue #98). torchao 0.13.0 est explicitement liste comme
REM compatible avec torch 2.7.1 dans cette meme table. Cote Linux
REM (install.sh), torch==2.10.0 correspond deja exactement a ce que veut
REM torchao 0.16.0 - la paire y est deja coherente, rien a changer.
uv pip install "transformers>=4.51.0,<4.58.0" diffusers gradio==6.2.0 matplotlib scipy soundfile loguru einops accelerate fastapi diskcache "uvicorn[standard]" numba vector-quantize-pytorch torchcodec "torchao==0.13.0" toml peft modelscope tensorboard typer-slim hf_transfer hf_xet lightning lycoris-lora safetensors xxhash "pytorch-wavelets>=1.3.0" "pywavelets>=1.9.0" "bitsandbytes>=0.50.0"
REM Install triton-windows for torch.compile + CUDA graphs (skip on CPU-only)
if not "%CUDA_VERSION%"=="cpu" (
    echo Installing Triton for torch.compile...
    uv pip install "triton-windows>=3.0.0,<3.4"
    REM Les distributions Python de uv (python-build-standalone) incluent
    REM deja les en-tetes de developpement, contrairement au zip embarque
    REM d'origine qui en etait volontairement depourvu - cette etape ne
    REM devrait normalement plus se declencher, gardee par securite.
    if not exist ".venv\Include\Python.h" (
        echo Installing Python headers for Triton...
        for /f "tokens=*" %%v in ('.venv\Scripts\python.exe -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}')"') do set "PY_VER=%%v"
        powershell -Command "& {[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://www.python.org/ftp/python/!PY_VER!/amd64/dev.msi' -OutFile 'downloads\pydev.msi'}"
        if exist "downloads\pydev.msi" (
            msiexec /a "downloads\pydev.msi" /qn TARGETDIR="%SCRIPT_DIR%downloads\pydev_extract"
            if not exist ".venv\Include" mkdir ".venv\Include"
            if not exist ".venv\libs" mkdir ".venv\libs"
            xcopy /E /Y "downloads\pydev_extract\include\*" ".venv\Include\" >nul 2>&1
            xcopy /E /Y "downloads\pydev_extract\libs\*" ".venv\libs\" >nul 2>&1
            if exist "downloads\pydev_extract" rmdir /s /q "downloads\pydev_extract"
            echo [OK] Python headers installed
        )
    )
)
REM Install Flash Attention 2 (pre-built wheel for RTX 40xx/50xx).
REM Source : marcorez8/flash-attn-windows-blackwell sur HuggingFace,
REM combinaison verifiee Python 3.11 + PyTorch 2.7 + CUDA 12.8 + Blackwell.
REM Comme la roue Linux, prebuilt avec un vrai toolchain a jour - pas besoin
REM de verification nvcc locale ici, contrairement au cas de compilation
REM depuis les sources rencontre sous Linux (voir TROUBLESHOOTING.md).
if "%CUDA_VERSION%"=="cu128" (
    echo Installing Flash Attention 2...
    uv pip install "https://huggingface.co/marcorez8/flash-attn-windows-blackwell/resolve/main/flash_attn-2.7.4.post1-cp311-cp311-win_amd64-torch2.7.0-cu128/flash_attn-2.7.4.post1-cp311-cp311-win_amd64.whl"
    if errorlevel 1 (
        echo ERROR: Flash Attention failed to install!
        pause
        exit /b 1
    )
    echo [OK] Flash Attention 2 installed
)
REM Install ace-step last (all deps already satisfied, no warnings)
uv pip install -e ACE-Step-1.5/ --no-deps

echo [5/10] Correctif pytorch_wavelets (pkg_resources)...
REM pytorch_wavelets (dependance de DCW) utilise encore
REM "from pkg_resources import resource_stream" pour charger ses coefficients
REM de filtres. Depuis setuptools 82 (8 fevrier 2026), pkg_resources n'est
REM plus fourni par defaut, et l'import echoue silencieusement - DCW se
REM desactive alors proprement, mais sans l'acceleration attendue. Meme
REM piege que basic-pitch/resampy, mais ici dans l'environnement PRINCIPAL
REM (torch/transformers/ACE-Step) : y retrograder setuptools globalement
REM serait bien plus risque que pour un venv isole. Correctif chirurgical
REM du fichier lui-meme a la place, sans toucher a setuptools. Idempotent.
if exist "patch-pytorch-wavelets.py" (
    .venv\Scripts\python.exe patch-pytorch-wavelets.py
) else (
    echo   WARNING: patch-pytorch-wavelets.py not found, patch skipped.
    echo   DCW will remain disabled ^(automatic fallback, no crash^).
)


REM ============================================================
REM  Step 6: Node.js
REM ============================================================
if exist "node\node.exe" (
    echo [OK] Node.js already installed
) else (
    echo [6/10] Downloading Node.js 22 LTS...
    if not exist "node" mkdir node
    powershell -Command "& {[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://nodejs.org/dist/v22.18.0/node-v22.18.0-win-x64.zip' -OutFile 'downloads\node.zip'}"
    if not exist "downloads\node.zip" (
        echo ERROR: Failed to download Node.js!
        pause
        exit /b 1
    )
    powershell -Command "& {Expand-Archive -Path 'downloads\node.zip' -DestinationPath 'downloads\node-extract' -Force}"
    powershell -Command "& {Get-ChildItem 'downloads\node-extract\node-*\*' | Move-Item -Destination 'node' -Force}"
    if exist "downloads\node-extract" rmdir /s /q "downloads\node-extract"
    echo [OK] Node.js 22 LTS installed
)

REM ============================================================
REM  Step 7: npm dependencies
REM ============================================================
echo [7/10] Installing npm dependencies...
set "PATH=%SCRIPT_DIR%node;%PATH%"

echo   Installing frontend deps...
cd /d "%SCRIPT_DIR%"
cd app
call "%SCRIPT_DIR%node\npm.cmd" install

echo   Installing server deps...
cd /d "%SCRIPT_DIR%"
cd app\server
call "%SCRIPT_DIR%node\npm.cmd" install

REM ============================================================
REM  Step 8: Build frontend
REM ============================================================
echo [8/10] Building frontend...
cd /d "%SCRIPT_DIR%"
cd app
call "%SCRIPT_DIR%node\npx.cmd" vite build

REM ============================================================
REM  Step 9: FFmpeg (for video rendering)
REM ============================================================
cd /d "%SCRIPT_DIR%"
if not exist "ffmpeg\ffmpeg.exe" (
    echo Downloading FFmpeg...
    if not exist "ffmpeg" mkdir ffmpeg
    powershell -Command "& {[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip' -OutFile 'downloads\ffmpeg.zip'}"
    if exist "downloads\ffmpeg.zip" (
        powershell -Command "& {Expand-Archive -Path 'downloads\ffmpeg.zip' -DestinationPath 'downloads\ffmpeg-extract' -Force}"
        powershell -Command "& {Get-ChildItem 'downloads\ffmpeg-extract\ffmpeg-*\bin\ffmpeg.exe' | Copy-Item -Destination 'ffmpeg\ffmpeg.exe' -Force}"
        powershell -Command "& {Get-ChildItem 'downloads\ffmpeg-extract\ffmpeg-*\bin\ffprobe.exe' | Copy-Item -Destination 'ffmpeg\ffprobe.exe' -Force}"
        if exist "downloads\ffmpeg-extract" rmdir /s /q "downloads\ffmpeg-extract"
        echo [OK] FFmpeg installed
    ) else (
        echo WARNING: Could not download FFmpeg. Video rendering will not work.
    )
)

REM ============================================================
REM  Step 10: Database migration (Playlists/Workspaces separation)
REM ============================================================
REM Utilise le node_modules du serveur (better-sqlite3), donc doit tourner
REM APRES l'installation npm de l'etape 7, jamais avant. Idempotent -
REM verifie l'etat reel de la base (colonne 'kind' deja presente ?) avant
REM d'y toucher, sans danger a relancer a chaque installation.
echo [9/10] Database migration (Playlists/Workspaces separation)...
cd /d "%SCRIPT_DIR%"
if exist "app\server\run-migration-kind.mjs" (
    cd app\server
    "%SCRIPT_DIR%node\node.exe" run-migration-kind.mjs
    cd /d "%SCRIPT_DIR%"
) else (
    echo   WARNING: app\server\run-migration-kind.mjs not found, migration skipped.
    echo   Playlists/Workspaces separation may not work correctly.
)

REM ============================================================
REM  Step 11: basic-pitch environment (MIDI conversion)
REM ============================================================
REM Environnement SEPARE - CONFIRME NECESSAIRE : une premiere tentative de
REM partage avec l'environnement principal a echoue en pratique.
REM basic-pitch entraine tensorflow<2.15.1, qui force lui-meme
REM tensorboard<2.16 - or ace-step 1.5.0 exige tensorboard>=2.20.0. Un
REM second venv, avec son propre site-packages, evite ce conflit - meme
REM logique que sous Linux.
echo [10/10] basic-pitch environment (MIDI conversion)...
if exist ".venv-basicpitch\Scripts\python.exe" (
    echo [OK] basic-pitch environment already installed
) else (
    uv venv --python 3.11 .venv-basicpitch
    if errorlevel 1 (
        echo   WARNING: Failed to create basic-pitch environment - MIDI conversion will not work.
        goto :skip_basicpitch
    )

    REM Version figee : sans elle, pip peut reculer vers d'anciennes versions
    REM de basic-pitch qui exigent un numpy anterieur a 1.24 - meme piege que
    REM sur Linux.
    REM setuptools<81 EXPLICITE : depuis setuptools 82 (8 fevrier 2026),
    REM pkg_resources n'est plus fourni par defaut. Seuil resserre a <81
    REM (plutot que <82) sur recommandation explicite du propre avertissement
    REM de depreciation de pkg_resources, confirme en pratique. resampy (dependance de
    REM basic-pitch) importe encore pkg_resources directement sans jamais
    REM declarer setuptools comme sa propre dependance - sans cette version
    REM plus ancienne, "ModuleNotFoundError: No module named 'pkg_resources'"
    REM au premier import, confirme en pratique.
    uv pip install --python .venv-basicpitch\Scripts\python.exe "setuptools<81"
    uv pip install --python .venv-basicpitch\Scripts\python.exe "basic-pitch[onnx]==0.4.0"

    REM Erreur affichee (pas de redirection vers nul) - un simple WARNING
    REM sans la vraie trace ne permet pas de diagnostiquer un echec.
    .venv-basicpitch\Scripts\python.exe -c "from basic_pitch.inference import predict"
    if errorlevel 1 (
        echo   WARNING: basic-pitch does not import correctly ^(see error above^). MIDI conversion will not work.
    ) else (
        echo [OK] basic-pitch environment installed
    )
)
:skip_basicpitch

REM ============================================================
REM  Save GPU config
REM ============================================================
echo %CUDA_VERSION%> cuda_version.txt

echo.
echo ========================================
echo   Installation complete!
echo.
echo   To start: run.bat
echo   Models download automatically on first run.
echo ========================================
pause