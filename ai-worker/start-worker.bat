@echo off
REM Start the queue worker (processes crawl/classify/score jobs from Redis)
set PYTHON_CMD=python
python --version >nul 2>&1
if %errorlevel% neq 0 (
    if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" set PYTHON_CMD=%LOCALAPPDATA%\Programs\Python\Python312\python.exe
    else if exist "%LOCALAPPDATA%\Programs\Python\Python311\python.exe" set PYTHON_CMD=%LOCALAPPDATA%\Programs\Python\Python311\python.exe
    else ( echo Python not found. & pause & exit /b 1 )
)
cd /d "%~dp0"
if exist ".venv\Scripts\activate.bat" ( call .venv\Scripts\activate.bat )
echo Starting queue worker...
python -m src.queue.worker
pause
