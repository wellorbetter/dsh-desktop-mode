@echo off
rem Put the DSH window back onto the desktop layer (full screen, no frame).
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\dsh-desktop.ps1" re-attach %*
