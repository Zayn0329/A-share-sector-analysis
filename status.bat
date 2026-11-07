@echo off
setlocal
cd /d "%~dp0"
if not defined PORT set "PORT=8787"

set "RUNNING_PID="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr "LISTENING" ^| findstr /C:":%PORT% "') do set "RUNNING_PID=%%P"

if not defined RUNNING_PID (
  echo [STOPPED] Nothing is listening on port %PORT%.
  echo Start it with start.bat or run_hidden.vbs
  pause
  exit /b 1
)

echo [RUNNING] PID %RUNNING_PID%  URL http://127.0.0.1:%PORT%
where curl >nul 2>&1
if errorlevel 1 (
  echo Open http://127.0.0.1:%PORT%/ in your browser to check data.
) else (
  curl -s -m 6 http://127.0.0.1:%PORT%/api/health
  echo.
)
pause
