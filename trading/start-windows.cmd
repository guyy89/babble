@echo off
rem Double-click launcher for Windows: starts the server and web UI, then opens the browser.
title DayTrader
cd /d "%~dp0"
if not exist node_modules call npm install
start "" cmd /c "timeout /t 6 /nobreak >nul & start http://localhost:5173"
npm run dev
