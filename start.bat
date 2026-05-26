@echo off
title Jarvis

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Node.js not found.
    pause & exit /b 1
)

if not exist node_modules (
    echo Installing dependencies...
    call npm install
)

echo.
echo Starting Jarvis server on port 3001...
start "Jarvis Server" node jarvis-server.js

timeout /t 2 /nobreak >nul

if exist C:\users\fabio.almeida\jarvis\cloudflared.exe (
    echo Starting Cloudflare Tunnel ^(jarvis.flowlog.dev^)...
    start "Jarvis Tunnel" C:\users\fabio.almeida\jarvis\cloudflared.exe tunnel run jarvis
    echo.
    echo JARVIS is live at https://jarvis.flowlog.dev
) else (
    echo No cloudflared found. Local only: http://localhost:3001
)

echo.
pause
