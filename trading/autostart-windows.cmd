@echo off
rem Run by a weekday Windows scheduled task: starts the system only if it is not already running,
rem so the momentum robot is up before its daily decision (09:45 New York).
cd /d "%~dp0"
curl -s -o nul --max-time 5 http://localhost:4000/api/health && exit /b 0
start "DayTrader" "%~dp0start-windows.cmd"
