@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

set "HF_HOME=%SCRIPT_DIR%models"
set "HUGGINGFACE_HUB_CACHE=%SCRIPT_DIR%models"
set "HF_HUB_ENABLE_HF_TRANSFER=1"

if not exist ".venv\Scripts\python.exe" (
    echo ERROR: Python not found! Run install.bat first.
    pause
    exit /b 1
)

REM hf_transfer accelere significativement les telechargements HuggingFace
REM (implementation Rust, plusieurs connexions paralleles) - mais
REM HF_HUB_ENABLE_HF_TRANSFER=1 seul ne fait rien si le paquet n'est pas
REM installe : huggingface_hub retombe silencieusement sur le mode normal
REM avec un simple avertissement, sans que l'utilisateur s'en rende compte.
REM Verifie et installe au besoin, une seule fois.
.venv\Scripts\python.exe -c "import hf_transfer" >nul 2>&1
if errorlevel 1 (
    echo Installation de hf_transfer ^(telechargement accelere^)...
    uv pip install hf_transfer
)

echo ========================================
echo   ACE-Step-Studio - Download Models
echo ========================================
echo.
echo Select model to download:
echo.
echo   1. XL Turbo - 18.8 GB, fast, 8 steps
echo   2. XL SFT - 18.8 GB, best quality, 50 steps
echo   3. XL Turbo BF16 - 9.3 GB, compact, less VRAM
echo   4. Download all three
echo.
set /p MODEL_CHOICE="Enter number 1-4: "

if "%MODEL_CHOICE%"=="1" goto :dl_turbo
if "%MODEL_CHOICE%"=="2" goto :dl_sft
if "%MODEL_CHOICE%"=="3" goto :dl_bf16
if "%MODEL_CHOICE%"=="4" goto :dl_all
echo Invalid choice!
pause
exit /b 1

:dl_turbo
echo.
echo Downloading ACE-Step XL Turbo...
.venv\Scripts\hf.exe download ACE-Step/acestep-v15-xl-turbo --local-dir "ACE-Step-1.5\checkpoints\acestep-v15-xl-turbo"
goto :done

:dl_sft
echo.
echo Downloading ACE-Step XL SFT...
.venv\Scripts\hf.exe download ACE-Step/acestep-v15-xl-sft --local-dir "ACE-Step-1.5\checkpoints\acestep-v15-xl-sft"
goto :done

:dl_bf16
echo.
echo Downloading ACE-Step XL Turbo BF16...
.venv\Scripts\hf.exe download marcorez8/acestep-v15-xl-turbo-bf16 --local-dir "ACE-Step-1.5\checkpoints\acestep-v15-xl-turbo-bf16"
goto :done

:dl_all
echo.
echo Downloading all three models...
echo.
echo [1/3] XL Turbo...
.venv\Scripts\hf.exe download ACE-Step/acestep-v15-xl-turbo --local-dir "ACE-Step-1.5\checkpoints\acestep-v15-xl-turbo"
echo.
echo [2/3] XL SFT...
.venv\Scripts\hf.exe download ACE-Step/acestep-v15-xl-sft --local-dir "ACE-Step-1.5\checkpoints\acestep-v15-xl-sft"
echo.
echo [3/3] XL Turbo BF16...
.venv\Scripts\hf.exe download marcorez8/acestep-v15-xl-turbo-bf16 --local-dir "ACE-Step-1.5\checkpoints\acestep-v15-xl-turbo-bf16"
goto :done

:done
echo.
echo ========================================
echo   Download complete!
echo ========================================
pause
