@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

echo ========================================
echo   ACE-Step Studio - Update
echo ========================================

where git >nul 2>&1
if errorlevel 1 (
    echo ERROR: Git not found! https://git-scm.com/downloads
    pause
    exit /b 1
)

REM ============================================================
REM  Step 1: Pull latest code
REM ============================================================
if exist ".git" (
    echo.
    echo [1/5] Updating ACE-Step Studio...
    git stash >nul 2>&1
    git pull
    git stash pop >nul 2>&1
) else (
    echo [1/5] No git repo, skipping code update
)

REM ============================================================
REM  Step 2: Update Python deps
REM ============================================================
if exist "python\python.exe" (
    echo.
    echo [2/5] Updating Python dependencies...
    python\python.exe -m pip install --upgrade pip --no-warn-script-location

    REM Update nano-vllm (local package)
    if exist "ACE-Step-1.5\acestep\third_parts\nano-vllm" (
        python\python.exe -m pip install -e ACE-Step-1.5/acestep/third_parts/nano-vllm/ --no-warn-script-location
    )

    REM Update all Python deps from install list
    python\python.exe -m pip install --upgrade "transformers>=4.51.0,<4.58.0" diffusers gradio==6.2.0 matplotlib scipy soundfile loguru einops accelerate fastapi diskcache "uvicorn[standard]" numba vector-quantize-pytorch torchcodec "torchao>=0.16.0,<0.17.0" toml peft modelscope tensorboard typer-slim hf_transfer hf_xet lightning lycoris-lora safetensors xxhash --no-warn-script-location

    REM Reinstall ace-step (picks up code changes)
    python\python.exe -m pip install -e ACE-Step-1.5/ --no-deps --no-warn-script-location
) else (
    echo [2/5] Python not found, skipping. Run install.bat first!
)

REM ============================================================
REM  Step 3-5: Update npm deps + rebuild frontend
REM ============================================================
if exist "node\node.exe" (
    set "PATH=%SCRIPT_DIR%node;%PATH%"

    echo.
    echo [3/5] Updating frontend dependencies...
    if exist "app\package.json" (
        cd app
        call "%SCRIPT_DIR%node\npm.cmd" install
        cd "%SCRIPT_DIR%"
    )

    echo.
    echo [4/5] Updating server dependencies...
    if exist "app\server\package.json" (
        cd app\server
        call "%SCRIPT_DIR%node\npm.cmd" install
        cd "%SCRIPT_DIR%"
    )

    echo.
    echo [5/5] Rebuilding frontend...
    if exist "app\vite.config.ts" (
        cd app
        call "%SCRIPT_DIR%node\npx.cmd" vite build
        cd "%SCRIPT_DIR%"
    )
) else (
    echo [3-5/5] Node.js not found, skipping npm steps. Run install.bat first!
)

echo.
echo ========================================
echo   Update complete!
echo ========================================
pause
