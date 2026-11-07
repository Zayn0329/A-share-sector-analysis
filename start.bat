@echo off
setlocal
cd /d "%~dp0"

if not defined PORT set "PORT=8787"
set "URL=http://127.0.0.1:%PORT%"

rem ---------- locate node.exe without relying on WorkBuddy's PATH ----------
set "NODE_EXE="
if defined WB_NODE_EXE if exist "%WB_NODE_EXE%" set "NODE_EXE=%WB_NODE_EXE%"
if not defined NODE_EXE (
  for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_EXE if exist "%%i" set "NODE_EXE=%%i"
)
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE (
  for /d %%D in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do if exist "%%D\node.exe" set "NODE_EXE=%%D\node.exe"
)

if not defined NODE_EXE (
  echo [ERROR] Node.js 18+ not found.
  echo   - Install Node.js LTS from https://nodejs.org/ , or
  echo   - set WB_NODE_EXE to the full path of node.exe
  echo.
  if /I not "%~1"=="silent" pause
  exit /b 1
)

if /I "%~1"=="check" (
  echo Node : %NODE_EXE%
  echo Port : %PORT%
  echo URL  : %URL%
  exit /b 0
)

rem ---------- is it already running? ----------
set "RUNNING_PID="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr "LISTENING" ^| findstr /C:":%PORT% "') do set "RUNNING_PID=%%P"
if defined RUNNING_PID (
  echo [INFO] Already running on port %PORT%, PID %RUNNING_PID%.
  echo [INFO] %URL%
  if /I not "%~1"=="silent" (
    start "" "%URL%"
    pause
  )
  exit /b 0
)

if /I "%~1"=="silent" (
  if not exist "logs" mkdir "logs" >nul 2>&1
  echo [%date% %time%] start node=%NODE_EXE% port=%PORT% >> "logs\server.log"
  "%NODE_EXE%" server.js >> "logs\server.log" 2>&1
  echo [%date% %time%] stop exit=%errorlevel% >> "logs\server.log"
  exit /b 0
)

echo [OK] Node   : %NODE_EXE%
echo [OK] Server : %URL%
echo [OK] Close this window to stop the server.
echo.
start "" "%URL%"
"%NODE_EXE%" server.js
echo.
echo [INFO] Server stopped, exit code %errorlevel%.
pause
