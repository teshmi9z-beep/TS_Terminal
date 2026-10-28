@echo off
rem Waits for the dev server, then opens the platform as an application window:
rem no tabs and no address bar, and the detached chart windows open the same way.
set "URL=http://localhost:5173/"

set "BROWSER_EXE="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "BROWSER_EXE=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER_EXE if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "BROWSER_EXE=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER_EXE if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "BROWSER_EXE=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER_EXE if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "BROWSER_EXE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"

for /l %%i in (1,1,60) do (
    curl.exe -s -o NUL "%URL%" && goto :open
    timeout /t 1 /nobreak >NUL
)

:open
if defined BROWSER_EXE (
    start "" "%BROWSER_EXE%" --app=%URL% --start-maximized
) else (
    start "" %URL%
)
