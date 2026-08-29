@echo off
setlocal enabledelayedexpansion

echo ACE-Step Studio - starting...
REM Cette ligne de diagnostic doit toujours s'afficher en premier. Si la
REM fenetre se ferme avant meme ce message, le probleme se situe au niveau
REM de l'analyse du fichier par cmd.exe lui-meme (encodage, BOM), pas dans
REM la logique du script - utile a savoir si le symptome revient malgre
REM le passage a de l'ASCII pur.

chcp 65001 >nul

REM =============================================================================
REM   ACE-Step Studio - launcher (Windows)
REM
REM   Usage :  run.bat [options]
REM
REM     --no-lm         Start without the local language model (5Hz LM 0.6B).
REM                      Frees ~1GB VRAM. Recommended for LoRA training and
REM                      pure DiT generation. Generation loses prompt expansion
REM                      and automatic metadata (can compensate with an
REM                      OpenRouter key in settings).
REM
REM     --gradio-only   Launch only the ACE-Step engine (Gradio UI, port 8001),
REM                      no Express or React frontend. Needed for dataset
REM                      preparation - labeling and saving only work in Gradio.
REM
REM     --no-browser    Do not automatically open a browser tab.
REM
REM     --port <n>      Web server port (default: 3001).
REM
REM     --help          Show this help.
REM =============================================================================

set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

REM === Argument parsing ========================================================
set "NO_LM=false"
set "GRADIO_ONLY=false"
set "NO_BROWSER=false"
set "WEB_PORT=3001"

:parse_args
if "%~1"=="" goto :args_done
if /i "%~1"=="--no-lm" (
    set "NO_LM=true"
    shift
    goto :parse_args
)
if /i "%~1"=="--gradio-only" (
    set "GRADIO_ONLY=true"
    shift
    goto :parse_args
)
if /i "%~1"=="--no-browser" (
    set "NO_BROWSER=true"
    shift
    goto :parse_args
)
if /i "%~1"=="--port" (
    set "WEB_PORT=%~2"
    shift
    shift
    goto :parse_args
)
if /i "%~1"=="--help" goto :show_help
if /i "%~1"=="-h" goto :show_help
echo Unknown option: %~1
echo Use --help for the list of options.
pause
exit /b 1

:show_help
echo   --no-lm         Start without the local language model (5Hz LM 0.6B).
echo   --gradio-only   Launch only the ACE-Step engine (Gradio UI, port 8001).
echo   --no-browser    Do not automatically open a browser tab.
echo   --port ^<n^>      Web server port (default: 3001).
echo   --help          Show this help.
exit /b 0

:args_done

echo ========================================
if "%GRADIO_ONLY%"=="true" (
    echo   ACE-Step Studio - Gradio only
) else (
    echo   ACE-Step Studio ^(Single Terminal^)
)
if "%NO_LM%"=="true" echo   No local LM mode
echo ========================================

REM === Checks ===================================================================
if not exist ".venv\Scripts\python.exe" (
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

REM === Environment isolation ====================================================
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
set PYTORCH_ALLOC_CONF=expandable_segments:True
set PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True

REM === Node.js in PATH ===========================================================
set "PATH=%SCRIPT_DIR%node;%PATH%"

REM === Pipeline config ===========================================================
set "PYTHON_PATH=%SCRIPT_DIR%.venv\Scripts\python.exe"
set "ACESTEP_PATH=%SCRIPT_DIR%ACE-Step-1.5"
if not defined DEFAULT_MODEL set "DEFAULT_MODEL=marcorez8/acestep-v15-xl-turbo-bf16"
set "MANAGE_PIPELINE=true"
set "PORT=%WEB_PORT%"

REM Dataset paths - all under ACE-Step-1.5\, never at the Studio root.
set "DATASETS_DIR=%SCRIPT_DIR%ACE-Step-1.5\datasets"
set "DATASETS_UPLOADS_DIR=%DATASETS_DIR%\uploads"
set "PREPROCESSED_TENSORS_DIR=%DATASETS_DIR%\preprocessed_tensors"
set "TENSOR_DIR=%PREPROCESSED_TENSORS_DIR%"
if not defined EXTRA_ALLOWED_PATHS set "EXTRA_ALLOWED_PATHS=%USERPROFILE%\Music"
if not exist "%PREPROCESSED_TENSORS_DIR%" mkdir "%PREPROCESSED_TENSORS_DIR%"
if not exist "%DATASETS_UPLOADS_DIR%" mkdir "%DATASETS_UPLOADS_DIR%"

REM === Engine .env file ==========================================================
REM Loaded BEFORE command-line options - those must win.
if exist "%SCRIPT_DIR%ACE-Step-1.5\.env" (
    echo Loading configuration from ACE-Step-1.5\.env...
    for /f "usebackq tokens=1,* delims==" %%a in ("%SCRIPT_DIR%ACE-Step-1.5\.env") do (
        set "line=%%a"
        if not "!line:~0,1!"=="#" if not "!line!"=="" set "%%a=%%b"
    )
)

REM --- Command-line options (override .env) ---
if "%NO_LM%"=="true" (
    set "INIT_LLM=false"
    set "ACESTEP_INIT_LLM=false"
)
if "%NO_BROWSER%"=="true" set "NO_AUTO_BROWSER=true"

if exist "cuda_version.txt" (
    set /p CUDA_VERSION=<cuda_version.txt
    echo GPU: !CUDA_VERSION!
)

REM === Gradio-only mode ==========================================================
if "%GRADIO_ONLY%"=="true" (
    set "INIT_LLM_ARG=true"
    if "%NO_LM%"=="true" set "INIT_LLM_ARG=false"

    echo.
    echo ========================================
    echo   Gradio UI: http://127.0.0.1:8001
    echo   Ctrl+C to stop
    echo ========================================
    echo.

    cd /d "%SCRIPT_DIR%ACE-Step-1.5"
    "%PYTHON_PATH%" -u -m acestep.acestep_v15_pipeline ^
        --config_path "%DEFAULT_MODEL%" ^
        --port 8001 ^
        --init_service true ^
        --init_llm "%INIT_LLM_ARG%" ^
        --enable-api ^
        --allowed-path "%USERPROFILE%\Music" ^
        --allowed-path "%EXTRA_ALLOWED_PATHS%" ^
        --offload_to_cpu true
    goto :end
)

REM === npm dependencies ===========================================================
if not exist "app\node_modules" (
    echo Installing npm dependencies ^(frontend^)...
    for /f "tokens=*" %%v in ('"%SCRIPT_DIR%node\node.exe" -v') do set "NODE_VER=%%v"
    set "NODE_VER=!NODE_VER:~1!"
    set "npm_config_target=!NODE_VER!"
    set "npm_config_target_arch=x64"
    set "npm_config_runtime=node"
    cd /d "%SCRIPT_DIR%app"
    "%SCRIPT_DIR%node\npm.cmd" install
    cd /d "%SCRIPT_DIR%"
)

if not exist "app\server\node_modules" (
    echo Installing npm dependencies ^(server^)...
    cd /d "%SCRIPT_DIR%app\server"
    "%SCRIPT_DIR%node\npm.cmd" install
    cd /d "%SCRIPT_DIR%"
)

REM === Build frontend if dist/ missing ============================================
if not exist "app\dist" (
    echo Building frontend...
    cd /d "%SCRIPT_DIR%app"
    call "%SCRIPT_DIR%node\npx.cmd" vite build
    cd /d "%SCRIPT_DIR%"
)

REM === Output directories ==========================================================
if not exist "app\data" mkdir "app\data"
if not exist "app\server\public\audio" mkdir "app\server\public\audio"

echo.
echo ========================================
echo   Single terminal mode
echo   Express + Pipeline + Frontend
echo   UI: http://localhost:%WEB_PORT%
echo   Close this window to stop all
echo ========================================
echo.

REM === Start Express (manages everything, opens browser when pipeline ready) ======
"%SCRIPT_DIR%node\node.exe" "%SCRIPT_DIR%app\server\node_modules\tsx\dist\cli.mjs" "%SCRIPT_DIR%app\server\src\index.ts"

if errorlevel 1 (
    echo.
    echo ERROR starting server!
    pause
    exit /b 1
)

:end
pause