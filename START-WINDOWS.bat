@echo off
setlocal
cd /d "%~dp0"
title BuildTrack Pro
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed.
  echo 1. Download the LTS version from https://nodejs.org
  echo 2. Install it, then double-click this file again.
  pause
  exit /b 1
)
if not exist client\dist\index.html (
  echo The folder client\dist is missing. Unzip the whole BuildTrack package again.
  pause
  exit /b 1
)
if not exist server\node_modules (
  echo Installing, please wait 1-3 minutes ^(internet needed^)...
  call npm --prefix server ci --omit=dev
  if errorlevel 1 (
    echo Install failed. Check your internet and try again.
    pause
    exit /b 1
  )
)
if not exist server\data\buildtrack.db (
  echo.
  echo FIRST START: create the owner account.
  set /p ADMIN_EMAIL=Owner email: 
  set /p ADMIN_PASSWORD=Owner password ^(8+ characters, letters and digits^): 
)
set PORT=3000
echo.
echo BuildTrack Pro is starting. Keep this window open while you use it.
echo Open http://localhost:3000 in your browser. To stop: close this window.
start "" cmd /c "timeout /t 4 >nul && start http://localhost:3000"
node server\src\server.js
pause
