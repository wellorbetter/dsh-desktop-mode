@echo off
rem Stop the DSH desktop layer and restore the normal desktop (icons + shell).
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\dsh-desktop.ps1" stop %*
