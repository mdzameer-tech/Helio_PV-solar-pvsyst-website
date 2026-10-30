@echo off
title HelioPV Solar Studio & ESP32 IoT Monitor Server
cd /d "%~dp0"

echo ======================================================================
echo   Launching HelioPV EPC Studio + ESP32 Solar Monitor...
echo ======================================================================

where node >nul 2>nul
if %ERRORLEVEL% equ 0 (
    echo Starting Node.js server on http://localhost:3000 ...
    start "" http://localhost:3000
    node server.js
) else (
    echo Starting local web server...
    start "" powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1" -Port 8080
    timeout /t 2 >nul
    start "" http://localhost:8080
)
