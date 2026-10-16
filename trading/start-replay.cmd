@echo off
rem Replays a recorded trading day in the normal UI (needs Alpaca keys in .env).
title DayTrader - replay
cd /d "%~dp0"
if not exist node_modules call npm install
set /p REPLAY_DATE=Date to replay (YYYY-MM-DD, a past weekday):
set /p REPLAY_SPEED=Speed (1 = real time, 5 = five times faster):
if "%REPLAY_SPEED%"=="" set REPLAY_SPEED=5
set DATA_SOURCE=replay
start "" cmd /c "timeout /t 8 /nobreak >nul & start http://localhost:5173"
npm run dev
