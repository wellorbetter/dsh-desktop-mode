@echo off
rem 卸载 DSH 桌面模式：停层、恢复普通桌面、撤自启、移除插件。
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" %*
if errorlevel 1 pause
