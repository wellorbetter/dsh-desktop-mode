@echo off
rem Pop the DSH window out of the desktop layer so it can take keyboard input.
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\dsh-desktop.ps1" pop-out %*
