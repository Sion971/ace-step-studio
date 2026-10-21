@echo off
REM =============================================================================
REM   ACE-Step Studio - raccourcis Windows ^(Bureau et menu Demarrer^)
REM
REM   Usage :  create-shortcut.bat [options]
REM
REM     --no-desktop   Ne cree pas le raccourci du Bureau.
REM     --no-menu      Ne cree pas le raccourci du menu Demarrer.
REM     --remove       Supprime les raccourcis crees ici.
REM
REM   Appele par install.bat en fin d'installation. L'icone est app\docs\Ace-Step UI.ico.
REM =============================================================================
setlocal
set "PS_ARGS="
:parse
if "%~1"=="" goto :run
if /i "%~1"=="--no-desktop" set "PS_ARGS=%PS_ARGS% -NoDesktop"
if /i "%~1"=="--no-menu" set "PS_ARGS=%PS_ARGS% -NoMenu"
if /i "%~1"=="--remove" set "PS_ARGS=%PS_ARGS% -Remove"
shift
goto :parse
:run
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0create-shortcut.ps1"%PS_ARGS%
exit /b %errorlevel%
