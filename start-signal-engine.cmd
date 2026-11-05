@echo off
title HyperSignal-Hiring - Hiring Radar
cd /d "%~dp0"
echo ============================================================
echo   HyperSignal-Hiring - local hiring radar
echo   Dashboard: http://localhost:4000
echo   (first ingest cycle runs on start - give it a few seconds)
echo   Keep this window open. Close it or press Ctrl+C to stop.
echo ============================================================
echo.
REM Open the dashboard in the default browser once the server is up.
start "" /min "%~dp0open-dashboard.cmd"
REM Run the app in this window so you can see logs.
call npm run start
echo.
echo HyperSignal-Hiring stopped.
pause >nul
