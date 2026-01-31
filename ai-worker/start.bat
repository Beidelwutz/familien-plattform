@echo off
REM Kiezling AI Worker Start Script
REM ================================

echo Starting Kiezling AI Worker...
echo.

REM Check for Python
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Python not found in PATH
    echo Please install Python 3.11+ from https://python.org
    echo Make sure to check "Add Python to PATH" during installation
    pause
    exit /b 1
)

REM Change to script directory
cd /d "%~dp0"

REM Check for virtual environment
if exist ".venv\Scripts\activate.bat" (
    echo Activating virtual environment...
    call .venv\Scripts\activate.bat
) else (
    echo No virtual environment found. Creating one...
    python -m venv .venv
    call .venv\Scripts\activate.bat
    echo Installing dependencies...
    pip install -r requirements.txt
)

REM Check if .env exists
if not exist ".env" (
    echo WARNING: .env file not found!
    echo Please copy .env.example to .env and configure it.
    if exist ".env.example" (
        copy .env.example .env
        echo Created .env from .env.example - please edit it with your settings.
    )
    pause
)

REM Start the worker
echo.
echo Starting AI Worker server on port 5000...
echo Press Ctrl+C to stop.
echo.
python -m src.main

pause
