@echo off
chcp 936 >nul
cd /d "%~dp0"

title Universal Proxy Client - Packer
echo ==========================================================
echo   Universal Proxy Client  -  Packer / Installer
----------------------------------------------------------
echo   Project : %~dp0
echo ==========================================================
echo.
echo   [1] Install    INSTALL to this PC  (RECOMMENDED)
echo                  -^> desktop shortcut + start menu + uninstaller
echo                  -^> no antivirus problem, double-click shortcut to run
echo   [2] Green zip  folder build + green zip  (RECOMMENDED for sharing)
echo                  -^> release\win-unpacked + release\UPC-green.zip
echo                  -^> recipient: unzip, then run the exe inside
echo   [3] Green dir  folder build only, release\win-unpacked
echo   [4] NSIS       NSIS setup installer (may fail, needs normal terminal)
echo   [5] Portable   single exe  (NOT RECOMMENDED, see warning below)
echo                  -^> NSIS self-extract into %%TEMP%% then run
echo                  -^> unsigned + fresh file: Windows Defender / SmartScreen
echo                     commonly block it, symptom is
echo                     "NSIS Error - Error writing temporary file"
echo                  -^> use [1] or [2] instead
echo   [6] All safe   install to this PC + green zip
echo.
set /p CHOICE=Select 1/2/3/4/5/6 then Enter: 

if not exist "node_modules" (
  echo.
  echo [ERROR] node_modules missing. Run: pnpm install
  pause
  exit /b 1
)

if not exist "node_modules\.bin\electron-builder.cmd" (
  echo.
  echo [ERROR] electron-builder not found in node_modules\.bin
  echo         Run: pnpm install
  pause
  exit /b 1
)

if "%CHOICE%"=="1" goto BUILD
if "%CHOICE%"=="2" goto BUILD
if "%CHOICE%"=="3" goto BUILD
if "%CHOICE%"=="4" goto BUILD
if "%CHOICE%"=="5" goto BUILD
if "%CHOICE%"=="6" goto BUILD
echo.
echo [ERROR] invalid choice, exit.
pause
exit /b 1

:BUILD
echo.
echo [build] renderer + main process (vite build) ...
call npx vite build
if errorlevel 1 (
  echo.
  echo [ERROR] vite build failed, stop.
  pause
  exit /b 1
)

if "%CHOICE%"=="1" goto INSTALL
if "%CHOICE%"=="2" goto GREENDIR
if "%CHOICE%"=="3" goto GREENDIR
if "%CHOICE%"=="4" goto NSIS
if "%CHOICE%"=="5" goto PORTABLE
if "%CHOICE%"=="6" goto INSTALL

:GREENDIR
echo.
echo [pack] green folder ...
call "node_modules\.bin\electron-builder.cmd" --win dir
if not exist "release\win-unpacked\*.exe" (
  echo.
  echo [ERROR] green build failed.
  pause
  exit /b 1
)
if "%CHOICE%"=="3" goto DONE
goto MAKEZIP

:MAKEZIP
echo.
echo [pack] green zip (no NSIS, no %%TEMP%% - safe to share) ...
set "SEVENZ=node_modules\.pnpm\7zip-bin@5.2.0\node_modules\7zip-bin\win\x64\7za.exe"
for /f "usebackq delims=" %%v in (`node -p "require('./package.json').version"`) do set "APPVER=%%v"
if not defined APPVER set "APPVER=0.0.0"
set "GREENZIP=release\UPC-green-%APPVER%.zip"
if not exist "%SEVENZ%" (
  echo [WARN] bundled 7za not found, skip zip. Use release\win-unpacked directly.
  goto DONE
)
del "release\UPC-green*.zip" >nul 2>&1
pushd release\win-unpacked
"%~dp0%SEVENZ%" a -tzip -mx=1 "..\UPC-green-%APPVER%.zip" "*" >nul
popd
if exist "%GREENZIP%" (
  echo   OK: %GREENZIP%
  echo   Share this zip. Recipient: unzip, right-click exe - Properties -
  echo   Unblock (if downloaded from chat/browser), then double-click.
) else (
  echo [WARN] zip failed. Use release\win-unpacked directly.
)
goto DONE

:INSTALL
echo.
echo [pack] green folder (source for installer) ...
call "node_modules\.bin\electron-builder.cmd" --win dir
if not exist "release\win-unpacked\*.exe" (
  echo.
  echo [ERROR] green build failed, install aborted.
  pause
  exit /b 1
)
echo.
echo [install] to this PC ...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if "%CHOICE%"=="6" goto GREENDIR
goto DONE

:NSIS
echo.
echo [pack] NSIS installer ...
call "node_modules\.bin\electron-builder.cmd" --win nsis
goto DONE

:PORTABLE
echo.
echo [pack] portable exe (may be blocked by antivirus on fresh builds) ...
call "node_modules\.bin\electron-builder.cmd" --win portable
echo.
echo   If double-click shows "NSIS Error - Error writing temporary file",
echo   it is the antivirus blocking self-extraction to %%TEMP%%, not a broken
echo   build. Use option [1] or [2] instead, or sign the exe.
goto DONE

:DONE
echo.
echo ==========================================================
echo   Finished. Output in release folder.
echo ==========================================================
if exist "release" start "" "%~dp0release"
pause
exit /b 0
