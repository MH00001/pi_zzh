@echo off
setlocal
set "PI_ROOT=%~dp0"
set "PI_NODE=F:\Miniconda3\envs\pi\node.exe"
if not exist "%PI_NODE%" (
    echo Pi conda environment was not found: %PI_NODE%
    pause
    exit /b 1
)
set "PATH=F:\Miniconda3\envs\pi;%PATH%"
start "Pi Agent" /D "%PI_ROOT%" powershell.exe -NoExit -NoProfile -ExecutionPolicy Bypass -File "%PI_ROOT%pi-test.ps1"
