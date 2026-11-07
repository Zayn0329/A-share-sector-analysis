@echo off
setlocal
cd /d "%~dp0"
if not defined PORT set "PORT=8787"

set "FOUND="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr "LISTENING" ^| findstr /C:":%PORT% "') do (
  echo [INFO] Stopping PID %%P on port %PORT%
  taskkill /PID %%P /F >nul 2>&1
  set "FOUND=1"
)

if not defined FOUND (
  echo [INFO] No server is listening on port %PORT%.
) else (
  echo [OK] Stopped.
)
pause
