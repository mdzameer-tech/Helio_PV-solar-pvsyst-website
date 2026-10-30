@echo off
title Solar String Monitor Server
cd /d "%~dp0"
echo ========================================================
echo Starting Solar String Monitor Web Server...
echo ========================================================

REM Check if node is in PATH, otherwise use the detected node binary
where node >nul 2>nul
if %ERRORLEVEL% equ 0 (
    node server.js
) else (
    echo Using bundled Node.js runtime...
    "C:\Users\Admin\AppData\Local\Programs\Python\Python312\Lib\site-packages\playwright\driver\node.exe" server.js
)

pause
