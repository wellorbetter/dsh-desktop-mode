#Requires -Version 7
<#
.SYNOPSIS
  卸载 DSH 桌面模式：停层并恢复普通桌面、撤自启、移除插件、删安装目录。

.DESCRIPTION
  顺序有意如此：先停（停层会恢复桌面图标并杀掉 web/壳/托盘/常驻进程），再撤自启、
  再移插件、最后删文件。用户的挂件配置 <安装目录>\widgets.json 默认**保留**成
  widgets.json.bak，只有 -Purge 才一并删除。

.EXAMPLE
  pwsh -File uninstall.ps1 -WhatIf
  pwsh -File uninstall.ps1
  pwsh -File uninstall.ps1 -Purge
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$InstallDir,
  [switch]$Purge
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

if (-not $InstallDir) { $InstallDir = Join-Path $env:LOCALAPPDATA 'dsh-desktop-mode' }
$launcher = Join-Path $InstallDir 'tools\dsh-desktop.ps1'
$dshCommand = Join-Path $env:USERPROFILE '.local\bin\dsh.cmd'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runValueName = 'DshDesktopLayer'

Write-Host 'DSH 桌面模式 · 卸载'
Write-Host "  安装目录：$InstallDir"

# 1) 停层（恢复图标；没有安装目录时也要能跑，所以不依赖 launcher 是否存在）
if (Test-Path $launcher) {
  Write-Host '  停止桌面层并恢复普通桌面…'
  if ($PSCmdlet.ShouldProcess($launcher, 'stop')) {
    & pwsh -NoProfile -ExecutionPolicy Bypass -File $launcher stop 2>&1 | ForEach-Object { "    $_" }
  }
} else {
  Write-Host '  安装目录里没有启动器：跳过停层（若桌面图标仍被隐藏，运行 restore-desktop-icons.ps1）'
}

# 2) 自启
if (Get-ItemProperty -Path $runKey -Name $runValueName -ErrorAction SilentlyContinue) {
  Write-Host "  移除开机自启：$runValueName"
  if ($PSCmdlet.ShouldProcess($runKey, "删除 $runValueName")) { Remove-ItemProperty -Path $runKey -Name $runValueName -Force }
}

# 3) 插件
if (Test-Path $dshCommand) {
  Write-Host '  从 profile 移除插件…'
  if ($PSCmdlet.ShouldProcess('profile web', '移除插件')) {
    & $dshCommand plugin --profile web remove dsh-plugin-desktop-mode 2>&1 | ForEach-Object { "    $_" }
  }
} else {
  Write-Host '  找不到 dsh：请手动移除插件（dsh plugin --profile web remove dsh-plugin-desktop-mode）'
}

# 4) 文件
if (Test-Path $InstallDir) {
  $config = Join-Path $InstallDir 'widgets.json'
  if ((Test-Path $config) -and -not $Purge) {
    $backup = Join-Path $InstallDir 'widgets.json.bak'
    Write-Host "  保留用户挂件配置：$backup"
    if ($PSCmdlet.ShouldProcess($backup, '备份用户配置')) { Copy-Item $config $backup -Force }
  }
  Write-Host "  删除安装目录：$InstallDir"
  if ($PSCmdlet.ShouldProcess($InstallDir, '删除安装目录')) {
    $keep = @()
    if (-not $Purge) { $keep = @('widgets.json.bak') }
    Get-ChildItem $InstallDir -Force | Where-Object { $keep -notcontains $_.Name } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Write-Host ''
Write-Host '卸载完成。桌面已恢复；如觉得还有残留，检查：'
Write-Host "  · $runKey\$runValueName（自启）"
Write-Host "  · $env:USERPROFILE\.dsh\profiles\web\package.json（插件依赖）"
