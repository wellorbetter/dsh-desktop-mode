@echo off
rem Start the DSH desktop layer (DSH web UI embedded as the Windows desktop).
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\dsh-desktop.ps1" start %*
