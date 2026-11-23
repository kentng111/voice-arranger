@echo off
rem Voice Arranger - local development server
cd /d "%~dp0"
set PORT=8000
where node >nul 2>nul
if %errorlevel%==0 goto node
where py >nul 2>nul
if %errorlevel%==0 goto py
where python >nul 2>nul
if %errorlevel%==0 goto python
echo Node.js or Python is required. See README.md
pause
goto :eof
:node
start "" cmd /c "timeout /t 1 >nul & start http://localhost:%PORT%/"
node tools\serve.mjs %PORT%
goto :eof
:py
start "" cmd /c "timeout /t 1 >nul & start http://localhost:%PORT%/"
py tools\serve.py %PORT%
goto :eof
:python
start "" cmd /c "timeout /t 1 >nul & start http://localhost:%PORT%/"
python tools\serve.py %PORT%
