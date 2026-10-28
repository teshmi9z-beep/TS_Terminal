@echo off
cd /d "%~dp0"
if not exist node_modules (
    echo Installation des dependances...
    call npm install
)
echo Demarrage de la plateforme...
rem opens the platform in Chrome "application" mode (no tabs / address bar) once the server is up
start "" /min cmd /c "%~dp0ouvrir-app.cmd"
call npm run dev
