@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

echo ========================================
echo   ACE-Step Studio
echo ========================================

set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

REM === Checks ===
if not exist "python\python.exe" (
    echo ERROR: Python not found! Run install.bat first
    pause
    exit /b 1
)
if not exist "node\node.exe" (
    echo ERROR: Node.js not found! Run install.bat first
    pause
    exit /b 1
)
if not exist "ACE-Step-1.5" (
    echo ERROR: ACE-Step-1.5 not found!
    pause
    exit /b 1
)

REM === Environment isolation ===
set "TEMP=%SCRIPT_DIR%temp"
set "TMP=%SCRIPT_DIR%temp"
if not exist "%TEMP%" mkdir "%TEMP%"

set "HF_HOME=%SCRIPT_DIR%models"
set "HUGGINGFACE_HUB_CACHE=%SCRIPT_DIR%models"
set "TRANSFORMERS_CACHE=%SCRIPT_DIR%models"
set "HF_HUB_ENABLE_HF_TRANSFER=1"
if not exist "%HF_HOME%" mkdir "%HF_HOME%"

set "TORCH_HOME=%SCRIPT_DIR%models\torch"
if not exist "%TORCH_HOME%" mkdir "%TORCH_HOME%"

set "XDG_CACHE_HOME=%SCRIPT_DIR%cache"
if not exist "%XDG_CACHE_HOME%" mkdir "%XDG_CACHE_HOME%"

if exist "%SCRIPT_DIR%ffmpeg\ffmpeg.exe" (
    set "PATH=%SCRIPT_DIR%ffmpeg;%PATH%"
)

set PYTHONIOENCODING=utf-8
set PYTHONUNBUFFERED=1
set PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True

REM === Node.js in PATH ===
set "PATH=%SCRIPT_DIR%node;%PATH%"

REM === Default model ===
set "DEFAULT_MODEL=acestep-v15-xl-turbo"
if exist "cuda_version.txt" (
    set /p CUDA_VERSION=<cuda_version.txt
    echo GPU: !CUDA_VERSION!
)

REM === Install npm deps if needed ===
if not exist "app\node_modules" (
    echo Installing npm dependencies...
    for /f "tokens=*" %%v in ('"%SCRIPT_DIR%node\node.exe" -v') do set "NODE_VER=%%v"
    set "NODE_VER=!NODE_VER:~1!"
    set "npm_config_target=!NODE_VER!"
    set "npm_config_target_arch=x64"
    set "npm_config_runtime=node"
    cd app
    "%SCRIPT_DIR%node\npm.cmd" install
    cd "%SCRIPT_DIR%"
)

REM === Create output dirs ===
if not exist "app\data" mkdir "app\data"
if not exist "app\server\public\audio" mkdir "app\server\public\audio"

echo.
echo Starting 3 services:
echo   [1] Gradio pipeline (port 8001)
echo   [2] Express backend (port 3001)
echo   [3] Vite frontend (port 3000)
echo.

REM === Start Gradio pipeline ===
set "ACESTEP_API_URL=http://localhost:8001"
set "ACESTEP_PATH=%SCRIPT_DIR%ACE-Step-1.5"
set "PYTHON_PATH=%SCRIPT_DIR%python\python.exe"

echo Starting Gradio pipeline with %DEFAULT_MODEL%...
start "ACE-Step Gradio" /D "%SCRIPT_DIR%ACE-Step-1.5" cmd /k %SCRIPT_DIR%python\python.exe -m acestep.acestep_v15_pipeline --config_path %DEFAULT_MODEL% --port 8001 --init_service true --init_llm true

REM Wait for Gradio to start loading
echo Waiting for Gradio to initialize...
timeout /t 5 /nobreak >nul

REM === Start Express backend ===
echo Starting Express backend...
start "ACE-Step Backend" /D "%SCRIPT_DIR%app\server" %SCRIPT_DIR%node\node.exe %SCRIPT_DIR%app\server\node_modules\tsx\dist\cli.mjs src/index.ts

timeout /t 2 /nobreak >nul

REM === Start Vite frontend ===
echo Starting frontend...
echo.
echo ========================================
echo   UI will open at http://localhost:3000
echo   Close all windows to stop
echo ========================================
echo.

cd /d "%SCRIPT_DIR%app"
%SCRIPT_DIR%node\npx.cmd vite --open

if errorlevel 1 (
    echo.
    echo ERROR starting frontend!
    echo Possible causes:
    echo 1. Dependencies not installed - run install.bat
    echo 2. Port 3000 already in use
    pause
    exit /b 1
)
pause
