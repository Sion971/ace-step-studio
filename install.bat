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
REM  Step 2: Python 3.12 Embedded
REM ============================================================
if exist "python\python.exe" (
    echo [OK] Python already installed
) else (
    echo [1/7] Downloading Python 3.12.9...
    if not exist "python" mkdir python
    powershell -Command "& {[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://www.python.org/ftp/python/3.12.9/python-3.12.9-embed-amd64.zip' -OutFile 'downloads\python.zip'}"
    if not exist "downloads\python.zip" (
        echo ERROR: Failed to download Python!
        pause
        exit /b 1
    )
    powershell -Command "& {Expand-Archive -Path 'downloads\python.zip' -DestinationPath 'python' -Force}"

    REM Patch _pth for site-packages
    cd python
    if exist "python312._pth" (
        echo python312.zip> python312._pth
        echo .>> python312._pth
        echo Lib\site-packages>> python312._pth
        echo ..\Lib\site-packages>> python312._pth
        echo import site>> python312._pth
    )
    cd ..
    echo [OK] Python 3.12.9 installed
)

REM ============================================================
REM  Step 3: pip
REM ============================================================
if exist "python\Scripts\pip.exe" (
    echo [OK] pip already installed
) else (
    echo [2/7] Installing pip...
    powershell -Command "& {[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://bootstrap.pypa.io/get-pip.py' -OutFile 'downloads\get-pip.py'}"
    python\python.exe downloads\get-pip.py --no-warn-script-location
)
python\python.exe -m pip install --upgrade pip --no-warn-script-location

REM ============================================================
REM  Step 4: PyTorch
REM ============================================================
echo [3/7] Installing PyTorch %TORCH_VERSION% (%CUDA_NAME%)...
python\python.exe -m pip install torch==%TORCH_VERSION% torchaudio==%TORCHAUDIO_VERSION% torchvision --index-url https://download.pytorch.org/whl/%CUDA_VERSION% --no-warn-script-location

REM ============================================================
REM  Step 5: ACE-Step dependencies
REM ============================================================
echo [4/7] Installing ACE-Step dependencies...
python\python.exe -m pip install hatchling editables --no-warn-script-location
REM Install nano-vllm first (local package, needed before ace-step)
python\python.exe -m pip install -e ACE-Step-1.5/acestep/third_parts/nano-vllm/ --no-warn-script-location
REM Install all deps before ace-step to avoid resolver warnings
python\python.exe -m pip install "transformers>=4.51.0,<4.58.0" diffusers gradio==6.2.0 matplotlib scipy soundfile loguru einops accelerate fastapi diskcache "uvicorn[standard]" numba vector-quantize-pytorch torchcodec "torchao>=0.16.0,<0.17.0" toml peft modelscope tensorboard typer-slim hf_transfer hf_xet lightning lycoris-lora safetensors xxhash "pytorch-wavelets>=1.3.0" "pywavelets>=1.9.0" --no-warn-script-location
REM Install triton-windows for torch.compile + CUDA graphs (skip on CPU-only)
if not "%CUDA_VERSION%"=="cpu" (
    echo Installing Triton for torch.compile...
    python\python.exe -m pip install "triton-windows>=3.0.0,<3.4" --no-warn-script-location
    REM Python headers needed for Triton launcher compilation
    if not exist "python\Include\Python.h" (
        echo Installing Python headers for Triton...
        for /f "tokens=*" %%v in ('python\python.exe -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}')"') do set "PY_VER=%%v"
        powershell -Command "& {[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://www.python.org/ftp/python/!PY_VER!/amd64/dev.msi' -OutFile 'downloads\pydev.msi'}"
        if exist "downloads\pydev.msi" (
            msiexec /a "downloads\pydev.msi" /qn TARGETDIR="%SCRIPT_DIR%downloads\pydev_extract"
            if not exist "python\Include" mkdir "python\Include"
            if not exist "python\libs" mkdir "python\libs"
            xcopy /E /Y "downloads\pydev_extract\include\*" "python\Include\" >nul 2>&1
            xcopy /E /Y "downloads\pydev_extract\libs\*" "python\libs\" >nul 2>&1
            if exist "downloads\pydev_extract" rmdir /s /q "downloads\pydev_extract"
            echo [OK] Python headers installed
        )
    )
)
REM Install Flash Attention 2 (pre-built wheel for RTX 40xx/50xx)
if "%CUDA_VERSION%"=="cu128" (
    echo Installing Flash Attention 2...
    python\python.exe -m pip install "https://github.com/mjun0812/flash-attention-prebuild-wheels/releases/download/v0.7.11/flash_attn-2.8.3%%2Bcu128torch2.7-cp312-cp312-win_amd64.whl" --no-warn-script-location
    if errorlevel 1 (
        echo ERROR: Flash Attention failed to install!
        pause
        exit /b 1
    )
    echo [OK] Flash Attention 2 installed
)
REM Install ace-step last (all deps already satisfied, no warnings)
python\python.exe -m pip install -e ACE-Step-1.5/ --no-deps --no-warn-script-location

REM ============================================================
REM  Step 6: Node.js
REM ============================================================
if exist "node\node.exe" (
    echo [OK] Node.js already installed
) else (
    echo [5/7] Downloading Node.js 22 LTS...
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
echo [6/7] Installing npm dependencies...
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
echo [7/7] Building frontend...
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
