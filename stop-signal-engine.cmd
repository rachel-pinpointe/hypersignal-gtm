@echo off
title Stop HyperSignal-Hiring
REM Stop the background server that's serving the dashboard on port 4000.
set "found="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":4000" ^| findstr LISTENING') do (
  taskkill /PID %%p /F >nul 2>&1
  set "found=1"
)
if defined found (
  echo HyperSignal-Hiring stopped.
) else (
  echo HyperSignal-Hiring was not running.
)
timeout /t 2 /nobreak >nul
