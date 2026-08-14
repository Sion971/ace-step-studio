@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

echo ========================================
echo   ACE-Step Studio - Clean Reinstall
echo ========================================
echo.
echo  This will DELETE and reinstall:
echo    - python\          (Python + all packages)
echo    - node\            (Node.js runtime)
echo    - app\node_modules (npm packages)
echo    - app\server\node_modules
echo    - app\dist          (frontend build)
echo    - downloads\        (cached installers)
echo.
echo  This will KEEP (safe):
echo    - models\           (downloaded models)
echo    - output\           (generated audio)
echo    - cache\            (HF cache with models)
echo    - app\data\         (database, settings)
echo    - app\server\public\audio\ (saved songs)
echo    - datasets\         (training data)
echo    - ffmpeg\           (ffmpeg binary)
echo    - lora_output\      (trained LoRAs)
echo    - ACE-Step-1.5\     (source code, not deps)
echo    - cuda_version.txt  (GPU config)
echo.

set /p CONFIRM="Type YES to continue: "
if /i not "%CONFIRM%"=="YES" (
    echo Cancelled.
    pause
    exit /b 0
)

echo.
echo ============================================================
echo  Cleaning software directories...
echo ============================================================

echo IMPORTANT: Close ACE-Step Studio (run.bat) before continuing!
echo If the app is running, files will be locked and cleanup will fail.
echo.

REM Remove Python (entire portable install + packages)
if exist "python" (
    echo Removing python\...
    rmdir /s /q "python"
    echo   [OK] python removed
)

REM Remove Node.js
if exist "node" (
    echo Removing node\...
    rmdir /s /q "node"
    echo   [OK] node removed
)

REM Remove node_modules (frontend)
if exist "app\node_modules" (
    echo Removing app\node_modules\...
    rmdir /s /q "app\node_modules"
    echo   [OK] app\node_modules removed
)

REM Remove node_modules (server)
if exist "app\server\node_modules" (
    echo Removing app\server\node_modules\...
    rmdir /s /q "app\server\node_modules"
    echo   [OK] app\server\node_modules removed
)

REM Remove frontend build
if exist "app\dist" (
    echo Removing app\dist\...
    rmdir /s /q "app\dist"
    echo   [OK] app\dist removed
)

REM Remove cached downloads (will re-download)
if exist "downloads" (
    echo Removing downloads\...
    rmdir /s /q "downloads"
    echo   [OK] downloads removed
)

REM Remove package-lock files to force fresh resolve
if exist "app\package-lock.json" del /f "app\package-lock.json"
if exist "app\server\package-lock.json" del /f "app\server\package-lock.json"

REM ============================================================
REM  Pull latest code before installing
REM ============================================================
where git >nul 2>&1
if not errorlevel 1 (
    if exist ".git" (
        echo.
        echo Pulling latest code...
        git stash >nul 2>&1
        git pull
        git stash pop >nul 2>&1
        echo   [OK] Code updated
    )
)

REM Show saved GPU config as hint
if exist "cuda_version.txt" (
    set /p SAVED_CUDA=<cuda_version.txt
    echo.
    echo NOTE: Your previous GPU config was: !SAVED_CUDA!
    echo       install.bat will ask you to select GPU again.
    echo       Choose the same option to keep your config.
)

echo.
echo ============================================================
echo  Starting fresh install...
echo ============================================================
echo.

REM Delegate to install.bat (now guaranteed to be the latest version)
call "%SCRIPT_DIR%install.bat"
