@echo off
REM Wait for the server to bind, then open the dashboard.
timeout /t 8 /nobreak >nul
start "" http://localhost:4000
exit
