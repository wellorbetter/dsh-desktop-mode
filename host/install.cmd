@echo off
rem 安装 DSH 桌面模式（插件 + 原生宿主）。可在命令行追加参数，例如 -SkipStart。
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
if errorlevel 1 pause
