@echo off
setlocal enableextensions enabledelayedexpansion
title Download with RGSX

:: This file lives in your RetroBat / Batocera folder, next to
:: rgsx-library-checker.html and the download list the Library Checker makes.
:: Double-click it to download every game on that list through RGSX.

set "ROOT_DIR=%~dp0"
if "%ROOT_DIR:~-1%"=="\" set "ROOT_DIR=%ROOT_DIR:~0,-1%"

set "SCRIPT=%ROOT_DIR%\rgsx_batch_download.py"
if not exist "%SCRIPT%" (
  echo Could not find rgsx_batch_download.py next to this file.
  echo Keep both files together in your RetroBat folder.
  echo.
  pause
  exit /b 1
)

:: Prefer the Python that RGSX itself uses (it already has the needed modules).
set "PYEXE="
if exist "%ROOT_DIR%\system\tools\Python\python.exe" set "PYEXE=%ROOT_DIR%\system\tools\Python\python.exe"

:: Otherwise a Python on PATH (skip the Microsoft Store stub).
if not defined PYEXE (
  for /f "delims=" %%I in ('where python.exe 2^>nul') do (
    echo %%~fI | "%SystemRoot%\System32\findstr.exe" /I /C:"\Microsoft\WindowsApps\python.exe" >nul
    if errorlevel 1 if not defined PYEXE set "PYEXE=%%~fI"
  )
)

:: Otherwise the py launcher.
set "PYLAUNCH="
if not defined PYEXE (
  py -3 --version >nul 2>&1 && set "PYLAUNCH=1"
)

if not defined PYEXE if not defined PYLAUNCH (
  echo Could not find Python on this computer.
  echo Start RGSX once in RetroBat ^(Ports ^> RGSX^) so it installs its Python, then try again.
  echo.
  pause
  exit /b 1
)

set "RGSX_HEADLESS=1"
pushd "%ROOT_DIR%"
echo.
if defined PYLAUNCH (
  py -3 "%SCRIPT%" %*
) else (
  "%PYEXE%" "%SCRIPT%" %*
)
set "RC=%ERRORLEVEL%"
popd

echo.
echo ------------------------------------------------------------
echo Finished. You can close this window.
pause
exit /b %RC%
