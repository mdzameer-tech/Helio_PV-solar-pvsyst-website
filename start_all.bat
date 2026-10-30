@echo off
title HelioPV Solar Studio & ESP32 IoT Monitor Server
cd /d "%~dp0"

echo ======================================================================
echo   Starting HelioPV Solar Studio + ESP32 Gateway Server (Port 3000)...
echo ======================================================================

where node >nul 2>nul
if %ERRORLEVEL% equ 0 (
    echo Starting Node.js backend server...
    start "" http://localhost:3000
    node server.js
) else (
    echo [Notice] Node.js not found in PATH.
    echo Launching standalone web interface...
    start "" index.html
    pause
)
