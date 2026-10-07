#Requires -Version 7
<#
.SYNOPSIS
  组装 DSH 桌面模式的发行包（zip）与校验和。

.DESCRIPTION
  发行包 = 插件（plugin\）+ 原生宿主（host\ + tools\）+ 文档与许可证。步骤：

   1. 先编译原生工具（tools\build-input-helper.ps1），保证包里是当次构建的 exe；
   2. 复制 host\ / tools\ / plugin\ 到 dist\dsh-desktop-mode-<版本>\；
   3. **断言**包里不存在私有目录（shell\ / logs\ / state\ / .evidence\ / config\）——
      这些是第三方 App 副本、运行日志、项目笔记与截图，任何情况下都不该发布；
   4. 压缩成 dist\dsh-desktop-mode-v<版本>.zip，并写 dist\SHA256SUMS.txt。

  版本号单一来源：plugin\package.json 的 version。

.EXAMPLE
  pwsh -File packaging\build-release.ps1 -WhatIf
  pwsh -File packaging\build-release.ps1
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [switch]$NoBuild,
  [switch]$KeepStaging
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

$repoRoot = Split-Path -Parent $PSScriptRoot
$pluginPackage = Join-Path $repoRoot 'plugin\package.json'
$version = (Get-Content $pluginPackage -Raw | ConvertFrom-Json).version
$distDir = Join-Path $repoRoot 'dist'
$stageDir = Join-Path $distDir "dsh-desktop-mode-$version"
$zipPath = Join-Path $distDir "dsh-desktop-mode-v$version.zip"
$toolExe = Join-Path $repoRoot 'tools\bin\dsh-desktop-input.exe'

Write-Host "DSH 桌面模式 · 组装发行包 v$version"

# 1) 原生工具
if ($NoBuild) {
  Write-Host '  跳过构建（-NoBuild）'
} else {
  Write-Host '  构建原生工具…'
  if ($PSCmdlet.ShouldProcess($toolExe, '编译')) {
    & pwsh -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repoRoot 'tools\build-input-helper.ps1') | Out-Null
  }
}
if (-not (Test-Path $toolExe)) { throw "原生工具未就绪：$toolExe（先运行 tools\build-input-helper.ps1）" }

# 2) 暂存目录
if ($PSCmdlet.ShouldProcess($stageDir, '重建暂存目录')) {
  if (Test-Path $stageDir) { Remove-Item $stageDir -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $stageDir | Out-Null
  foreach ($item in 'host', 'tools', 'plugin', 'README.md', 'README.en.md', 'LICENSE') {
    $source = Join-Path $repoRoot $item
    if (-not (Test-Path $source)) { throw "发行包缺少 $item" }
    Copy-Item $source (Join-Path $stageDir $item) -Recurse -Force
  }
  # 插件目录里的 node_modules（如果有）不属于发行内容
  Get-ChildItem $stageDir -Recurse -Directory -Filter 'node_modules' -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

# 3) 私有内容断言
$forbidden = @('shell', 'logs', 'state', '.evidence', 'config')
$leaks = @()
foreach ($name in $forbidden) {
  $path = Join-Path $stageDir $name
  if (Test-Path $path) { $leaks += $name }
}
if ($leaks.Count -gt 0) {
  throw "发行包里出现了不该发布的内容：$($leaks -join ', ') —— 请检查 build-release.ps1 的复制清单"
}
Write-Host "  私有内容检查通过（不含 $($forbidden -join ' / ')）"

# 4) 压缩 + 校验和
if ($PSCmdlet.ShouldProcess($zipPath, '压缩并写校验和')) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
  [System.IO.Compression.ZipFile]::CreateFromDirectory($stageDir, $zipPath, [System.IO.Compression.CompressionLevel]::Optimal, $false)
  $hash = (Get-FileHash $zipPath -Algorithm SHA256).Hash
  $zipName = Split-Path -Leaf $zipPath
  "$hash  $zipName" | Set-Content (Join-Path $distDir 'SHA256SUMS.txt') -Encoding utf8
  if (-not $KeepStaging) { Remove-Item $stageDir -Recurse -Force }
}

if (Test-Path $zipPath) {
  $size = [Math]::Round((Get-Item $zipPath).Length / 1MB, 2)
  Write-Host "  产物：$zipPath（$size MB）"
  Write-Host "  校验和：$(Get-Content (Join-Path $distDir 'SHA256SUMS.txt') -Raw)"
  Write-Host ''
  Write-Host '  包内顶层内容：'
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
  try {
    $zip.Entries | ForEach-Object { ($_.FullName -split '/')[0] } | Sort-Object -Unique | ForEach-Object { "    $_" }
  } finally { $zip.Dispose() }
}
