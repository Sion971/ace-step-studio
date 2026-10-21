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
REM     --quit-on-close Stop the Studio (server and engine) when the last page is
REM                     closed. It first waits for a running generation, training
REM                     or download to finish.
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
set "QUIT_ON_CLOSE=false"
set "WEB_PORT=3001"

:parse_args
if "%~1"=="" goto :args_done

REM === Is a session already running? ============================================
REM A second launch must not touch anything: it would empty the first session's
REM caches, fight for the card and the ports, then fail with an obscure error.
REM So we look for a listener on the web port (3001 by default) and on the engine
REM port (8001, fixed) and stop before doing anything else. The test does not
REM rely on the word LISTENING (translated on non-English Windows): a listening
REM socket is one whose remote address ends in ":0" (0.0.0.0:0 or [::]:0).
set "BUSY_PORT="
if not "%GRADIO_ONLY%"=="true" (
    netstat -ano | findstr /R /C:":%WEB_PORT% *[^ ]*:0 " >nul
    if not errorlevel 1 set "BUSY_PORT=%WEB_PORT%"
)
if not defined BUSY_PORT (
    netstat -ano | findstr /R /C:":8001 *[^ ]*:0 " >nul
    if not errorlevel 1 set "BUSY_PORT=8001"
)
if defined BUSY_PORT (
    echo ========================================
    echo   ACE-Step Studio is already running
    echo ========================================
    echo Port !BUSY_PORT! is already in use: another Studio session ^(or another program^) is using it.
    echo This launch is cancelled; the running session is untouched.
    if "!BUSY_PORT!"=="%WEB_PORT%" echo To use it, open http://localhost:%WEB_PORT% in your browser.
    echo To replace it: stop it first ^(Ctrl+C in its window, or close its page if it was started with
    echo --quit-on-close^), then launch again.
    pause
    exit /b 1
)

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
if /i "%~1"=="--quit-on-close" (
    set "QUIT_ON_CLOSE=true"
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
echo   --quit-on-close Stop the Studio when the last page is closed.
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
REM TRANSFORMERS_CACHE retiree : deprecie par la bibliotheque Transformers
REM elle-meme (avertissement FutureWarning, retrait prevu en v5), et
REM redondante ici — HF_HOME ci-dessus couvre deja exactement le meme
REM usage.
set "HF_HUB_ENABLE_HF_TRANSFER=1"
REM HF_XET_HIGH_PERFORMANCE : le reglage equivalent pour Xet, actif par
REM defaut depuis huggingface_hub>=0.32.0 - fixe aux cotes du reglage
REM ci-dessus pour couvrir toute version installee (0.36.x comme 1.x),
REM sans avoir a determiner laquelle est active.
set "HF_XET_HIGH_PERFORMANCE=1"
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
REM Smart App Control peut refuser un fichier natif pendant plusieurs minutes ^(TROUBLESHOOTING.md, section 46^) :
REM on laisse le gestionnaire relancer le moteur plus longtemps avant d'abandonner ^(10 par defaut, environ 2 min 30^).
if not defined PIPELINE_MAX_RESTARTS set "PIPELINE_MAX_RESTARTS=40"
REM Python des environnements isoles ^(conversion MIDI et separation de stems^), crees par install.bat.
REM Sans ces variables, le serveur cherche des chemins Linux ^(bin/python3^) et ne trouve rien sous Windows.
set "BASIC_PITCH_PYTHON_PATH=%SCRIPT_DIR%.venv-basicpitch\Scripts\python.exe"
set "DEMUCS_PYTHON_PATH=%SCRIPT_DIR%.venv-demucs\Scripts\python.exe"
REM Profil materiel ^(install.bat, ou ici s'il manque^) : modele par defaut selon la VRAM, comme run.sh.
REM Priorites : DEFAULT_MODEL deja defini, puis ACE-Step-1.5\.env ^(lu plus bas^), puis le profil, puis l'ancien defaut.
if exist "%SCRIPT_DIR%hardware_profile.env" goto :hw_profile_read
if not exist "%SCRIPT_DIR%write-hardware-profile.py" goto :hw_profile_done
"%PYTHON_PATH%" "%SCRIPT_DIR%write-hardware-profile.py" 2>nul
:hw_profile_read
if not exist "%SCRIPT_DIR%hardware_profile.env" goto :hw_profile_done
for /f "usebackq tokens=1,* delims==" %%a in ("%SCRIPT_DIR%hardware_profile.env") do (
    set "line=%%a"
    if "!line:~0,3!"=="HW_" set "%%a=%%b"
)
:hw_profile_done
if not defined DEFAULT_MODEL if defined HW_DEFAULT_MODEL set "DEFAULT_MODEL=!HW_DEFAULT_MODEL!"
if not defined DEFAULT_MODEL set "DEFAULT_MODEL=marcorez8/acestep-v15-xl-turbo-bf16"
REM Aucun modele de langage aux paliers 1 et 2 ^(4 Go de VRAM ou moins, et mode processeur^).
if /i "!HW_INIT_LLM!"=="false" if not defined INIT_LLM set "INIT_LLM=false" & set "ACESTEP_INIT_LLM=false"
REM Mode processeur : la limite de 600 s d'ACE-Step est faite pour des GPU.
if defined HW_GENERATION_TIMEOUT if not defined ACESTEP_GENERATION_TIMEOUT set "ACESTEP_GENERATION_TIMEOUT=!HW_GENERATION_TIMEOUT!"
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
if "%QUIT_ON_CLOSE%"=="true" set "STUDIO_QUIT_ON_CLOSE=true"

if exist "cuda_version.txt" (
    set /p CUDA_VERSION=<cuda_version.txt
    echo GPU: !CUDA_VERSION!
)
if defined HW_GPU_NAME (
    if /i "!HW_MODE!"=="cpu" (
        echo Profil materiel : mode processeur, palier ACE-Step !HW_ACE_TIER!
        echo Delai de generation : !ACESTEP_GENERATION_TIMEOUT! s
    ) else if /i "!HW_MODE!"=="stream" (
        echo Profil materiel : !HW_GPU_NAME!, petite carte ^(!HW_VRAM_CLASS_GB! Go^) : mode flux, DiT bloc par bloc et audio decode par la carte
        echo Delai de generation : !ACESTEP_GENERATION_TIMEOUT! s
    ) else (
        echo Profil materiel : !HW_GPU_NAME!, !HW_VRAM_CLASS_GB! Go, palier ACE-Step !HW_ACE_TIER!
    )
    set "LM_TXT=active"
    if /i "!INIT_LLM!"=="false" set "LM_TXT=desactive"
    echo Modele par defaut : !DEFAULT_MODEL!, modele de langage !LM_TXT!
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

REM === Attente Smart App Control ==================================================
REM install.bat cree sac_pending.txt quand Windows refusait encore des fichiers natifs a la fin de l'installation.
REM On attend ici qu'il les accepte ^(20 minutes au plus^) plutot que de laisser le moteur echouer en boucle.
if not exist "%SCRIPT_DIR%sac_pending.txt" goto :sac_wait_done
set "SAC_TRY=0"
echo.
echo Windows verifie encore certains fichiers de l'installation ^(Smart App Control^). Attente en cours...
:sac_wait
set "SAC_BAD=0"
"%PYTHON_PATH%" "%SCRIPT_DIR%check-imports.py" main 2>nul
if errorlevel 1 set "SAC_BAD=1"
if exist "%SCRIPT_DIR%.venv-basicpitch\Scripts\python.exe" (
    "%SCRIPT_DIR%.venv-basicpitch\Scripts\python.exe" "%SCRIPT_DIR%check-imports.py" basicpitch 2>nul
    if errorlevel 1 set "SAC_BAD=1"
)
if exist "%SCRIPT_DIR%.venv-demucs\Scripts\python.exe" (
    "%SCRIPT_DIR%.venv-demucs\Scripts\python.exe" "%SCRIPT_DIR%check-imports.py" demucs 2>nul
    if errorlevel 1 set "SAC_BAD=1"
)
if exist "%SCRIPT_DIR%ffmpeg\ffmpeg.exe" (
    "%SCRIPT_DIR%ffmpeg\ffmpeg.exe" -version >nul 2>nul
    if errorlevel 1 set "SAC_BAD=1"
)
if exist "%SCRIPT_DIR%ffmpeg\ffprobe.exe" (
    "%SCRIPT_DIR%ffmpeg\ffprobe.exe" -version >nul 2>nul
    if errorlevel 1 set "SAC_BAD=1"
)
if "%SAC_BAD%"=="0" goto :sac_wait_ok
set /a SAC_TRY+=1
if %SAC_TRY% GEQ 60 goto :sac_wait_giveup
echo   Essai %SAC_TRY% sur 60 - nouvel essai dans 20 secondes...
timeout /t 20 /nobreak >nul
goto :sac_wait
:sac_wait_giveup
echo   Des fichiers sont toujours refuses : demarrage quand meme ^(le moteur reessaiera^).
goto :sac_wait_done
:sac_wait_ok
del "%SCRIPT_DIR%sac_pending.txt"
echo   OK - Windows a accepte les fichiers.
:sac_wait_done

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

REM === Compilation du frontend : app\dist manque, ou la version du depot a change ===
REM Avant, l'interface n'etait compilee que si app\dist MANQUAIT : apres un git pull, l'ancienne interface
REM restait servie. On note la version ^(git rev-parse HEAD^) dans app\dist\.build-commit et on recompile
REM quand elle differe. La compilation se fait dans app\dist.tmp : un echec garde l'ancienne interface.
REM Sans git, seule l'absence de app\dist declenche la compilation.
set "FRONT_NOW="
set "FRONT_BUILT="
set "FRONT_BUILD="
where git >nul 2>&1
if not errorlevel 1 for /f %%h in ('git -C "%SCRIPT_DIR%." rev-parse HEAD 2^>nul') do set "FRONT_NOW=%%h"
if exist "app\dist\.build-commit" set /p FRONT_BUILT=<"app\dist\.build-commit"
if not exist "app\dist\index.html" set "FRONT_BUILD=1"
if defined FRONT_NOW if /i not "!FRONT_NOW!"=="!FRONT_BUILT!" set "FRONT_BUILD=1"
if not defined FRONT_BUILD goto :front_done
echo Compilation du frontend...
if exist "app\dist.tmp" rmdir /s /q "app\dist.tmp"
cd /d "%SCRIPT_DIR%app"
call "%SCRIPT_DIR%node\npx.cmd" vite build --outDir dist.tmp --emptyOutDir
set "FRONT_RC=!errorlevel!"
cd /d "%SCRIPT_DIR%"
if not "!FRONT_RC!"=="0" goto :front_failed
if exist "app\dist" rmdir /s /q "app\dist"
ren "app\dist.tmp" "dist"
if defined FRONT_NOW >"app\dist\.build-commit" echo !FRONT_NOW!
goto :front_done
:front_failed
echo ATTENTION : la compilation du frontend a echoue. L'ancienne interface est conservee si elle existe.
if exist "app\dist.tmp" rmdir /s /q "app\dist.tmp"
:front_done

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
if "%QUIT_ON_CLOSE%"=="true" exit /b 0
pause