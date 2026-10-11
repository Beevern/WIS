@echo off
title WIS Backend Server
cd /d "%~dp0"
call npm run dev
echo.
echo Server stopped. Press any key to close...
pause > nul
