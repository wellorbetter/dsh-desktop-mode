#Requires -Version 7
<#
.SYNOPSIS
  Install DSH 桌面模式：插件（界面那半）+ 原生宿主（桌面层/图标/键盘/自启/托盘）。

.DESCRIPTION
  一次做完五件事，每一步都会打印它做了什么：

   1. 找到**宿主 App**（那个把 DSH 网页装进窗口的 Electron 桌面版）：
      优先用 -ShellExe；否则找已经解包的；否则发现 ~/.local/share/dsh/desktop-preview-*/desktop.zip
      并解包到 <安装目录>\app —— 有 zip 的用户不需要自己解包。
   2. 把工具复制到安装目录（默认 %LOCALAPPDATA%\dsh-desktop-mode）。
   3. 写 config.json：宿主 App 路径、端口、工具路径 —— 装到别处后启动器靠它工作。
   4. 装插件：用**包内自带的** plugin 目录做本地 link 安装 —— 这个包是自包含的，
      不需要 npm、不需要联网。（想从 npm 装（将来发布后）加 -FromNpm。）
   5. 注册开机自启（HKCU Run，可用 -SkipAutostart 跳过），可选立即启动。

  只有 -WhatIf 时不写任何东西，只打印计划。

.EXAMPLE
  pwsh -File install.ps1 -WhatIf
  pwsh -File install.ps1
  pwsh -File install.ps1 -ShellExe "D:\DSH Desktop\DSH Desktop.exe" -SkipStart
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$ShellExe,
  [int]$WebPort = 3081,
  [int]$DebugPort = 9222,
  [string]$InstallDir,
  # Kept for compatibility: installing the bundled plugin is now the default, so
  # this switch no longer changes anything.
  [switch]$FromLocal,
  # Install dsh-plugin-desktop-mode from the npm registry instead of the copy in
  # this archive. Only useful once the package is actually published there.
  [switch]$FromNpm,
  [switch]$SkipAutostart,
  [switch]$SkipStart
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

$releaseRoot = $PSScriptRoot
$launcherSource = Join-Path $releaseRoot 'tools\dsh-desktop.ps1'
# Two layouts are supported: the release zip (install.ps1 next to tools\ and
# plugin\) and the development repo (this script lives in host\, the payload is one
# level up). Detecting instead of assuming keeps one installer for both.
if (-not (Test-Path $launcherSource)) {
  $parent = Split-Path -Parent $releaseRoot
  if (Test-Path (Join-Path $parent 'tools\dsh-desktop.ps1')) { $releaseRoot = $parent }
  $launcherSource = Join-Path $releaseRoot 'tools\dsh-desktop.ps1'
}
$pluginSource = Join-Path $releaseRoot 'plugin'
$dshCommand = Join-Path $env:USERPROFILE '.local\bin\dsh.cmd'
# Some environments (an agent session, a service, a fresh shell) do not have the
# harness bin directory on PATH, and this script is routinely run from exactly
# such a context; fall back to resolving `dsh` normally before giving up.
if (-not (Test-Path $dshCommand)) {
  $resolved = Get-Command dsh -ErrorAction SilentlyContinue
  if ($resolved) { $dshCommand = $resolved.Source } else { $dshCommand = '' }
}
if (-not $InstallDir) { $InstallDir = Join-Path $env:LOCALAPPDATA 'dsh-desktop-mode' }
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runValueName = 'DshDesktopLayer'
$plan = [ordered]@{}

function Say([string]$text) { Write-Host $text }

if (-not (Test-Path $launcherSource)) { throw "发行包不完整：找不到 $launcherSource" }
if (-not (Test-Path $dshCommand)) { throw "找不到 dsh（$dshCommand）——请先安装 DSH" }

# --------------------------------------------------------------- 宿主 App --
function Find-HostApp {
  param([string]$Explicit)
  if ($Explicit) {
    if (-not (Test-Path $Explicit)) { throw "指定的宿主 App 不存在：$Explicit" }
    return (Resolve-Path $Explicit).Path
  }
  $candidates = New-Object System.Collections.Generic.List[string]
  # 1. 上次安装留下的（我们自己解包的）
  foreach ($pattern in 'DeepSeek Harness*.exe', 'dsh-wallpaper-engine-desktop*.exe', 'DSH Desktop*.exe') {
    $found = Get-ChildItem (Join-Path $InstallDir 'app') -Filter $pattern -File -ErrorAction SilentlyContinue
    if ($found) { $candidates.Add($found[0].FullName) }
  }
  # 2. 发行包里若自带 shell\app（开发者本地跑 install 的情形）
  $bundled = Get-ChildItem (Join-Path $releaseRoot 'shell\app') -Filter 'DeepSeek Harness*.exe' -File -ErrorAction SilentlyContinue
  if ($bundled) { $candidates.Add($bundled[0].FullName) }
  # 3. 常见安装位置（浅层搜索，别把整块盘翻一遍）
  $roots = @(
    (Join-Path $env:LOCALAPPDATA 'Programs'),
    (Join-Path $env:USERPROFILE '.local\share\dsh'),
    'D:\DSH Desktop',
    'C:\DSH Desktop'
  )
  foreach ($root in $roots) {
    if (-not (Test-Path $root)) { continue }
    foreach ($pattern in 'DeepSeek Harness*.exe', 'dsh-wallpaper-engine-desktop*.exe', 'DSH Desktop*.exe') {
      $found = Get-ChildItem $root -Filter $pattern -File -Recurse -Depth 3 -ErrorAction SilentlyContinue
      foreach ($item in $found) { $candidates.Add($item.FullName) }
    }
  }
  return ($candidates | Select-Object -First 1)
}

# desktop.zip 里就是应用本体（exe 在压缩包根目录），所以有它就直接解包。
function Expand-HostAppFromZip {
  param([string]$Target)
  $zip = Get-ChildItem (Join-Path $env:USERPROFILE '.local\share\dsh') -Filter 'desktop.zip' -Recurse -Depth 2 -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $zip) { return $null }
  Say "  发现桌面端压缩包：$($zip.FullName)"
  if ($PSCmdlet.ShouldProcess($Target, "解包 $($zip.Name)")) {
    New-Item -ItemType Directory -Force -Path $Target | Out-Null
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($zip.FullName, $Target, $true)
    $exe = Get-ChildItem $Target -Filter 'DeepSeek Harness*.exe' -File -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($exe) { return $exe.FullName }
  }
  return $null
}

Say 'DSH 桌面模式 · 安装'
Say "  安装目录：$InstallDir"
Say "  发行包根：$releaseRoot"

$resolvedShell = Find-HostApp -Explicit $ShellExe
if (-not $resolvedShell) {
  Say '  未找到宿主 App，尝试从 desktop.zip 解包…'
  $resolvedShell = Expand-HostAppFromZip -Target (Join-Path $InstallDir 'app')
}
if (-not $resolvedShell) {
  throw @"
找不到宿主 App（把 DSH 网页装进窗口的那个桌面版）。三种办法：
  · 装好桌面端后重跑，或
  · 用 -ShellExe "<桌面端 exe 的完整路径>" 指定，或
  · 把桌面端的 desktop.zip 放到 $env:USERPROFILE\.local\share\dsh\ 下（安装器会自动解包）
"@
}
Say "  宿主 App：$resolvedShell"
$plan.shellExe = $resolvedShell

# ------------------------------------------------------------------ 复制 --
$payload = @{
  (Join-Path $releaseRoot 'tools') = (Join-Path $InstallDir 'tools')
}
if (Test-Path $pluginSource) { $payload[$pluginSource] = (Join-Path $InstallDir 'plugin') }
foreach ($source in $payload.Keys) {
  $target = $payload[$source]
  Say "  复制 $source -> $target"
  if ($PSCmdlet.ShouldProcess($target, '复制工具文件')) {
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    Copy-Item (Join-Path $source '*') $target -Recurse -Force
  }
}
if ($PSCmdlet.ShouldProcess($InstallDir, '写 config.json')) {
  New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir 'logs') | Out-Null
  [pscustomobject]@{
    shellExe   = $resolvedShell
    webPort    = $WebPort
    debugPort  = $DebugPort
    tool       = Join-Path $InstallDir 'tools\bin\dsh-desktop-input.exe'
    launcher   = Join-Path $InstallDir 'tools\dsh-desktop.ps1'
    installedAt = (Get-Date).ToString('o')
    source     = $releaseRoot
  } | ConvertTo-Json | Set-Content (Join-Path $InstallDir 'config.json') -Encoding utf8
}

# ------------------------------------------------------------------ 插件 --
# The plugin is installed from the copy inside this archive.
#
# Link the *installed* copy, not the directory this script was run from: people
# install from their Downloads folder and delete the archive afterwards, which
# would break a link pointing back into it (the payload copy above already put a
# durable copy in the install dir). No npm and no network are involved, which is
# what makes this archive self-contained.
$installedPlugin = Join-Path $InstallDir 'plugin'
$pluginLinkSource = if (Test-Path (Join-Path $installedPlugin 'package.json')) { $installedPlugin } else { $pluginSource }
$bundledSpec = "link:$pluginLinkSource"
$pluginSpec = if ($FromNpm) { 'dsh-plugin-desktop-mode' } else { $bundledSpec }
if (-not (Test-Path $pluginLinkSource)) { throw "发行包不完整：找不到插件目录 $pluginLinkSource" }
Say "  安装插件：dsh plugin --profile web add $pluginSpec"
if ($PSCmdlet.ShouldProcess('profile web', "安装插件 $pluginSpec")) {
  & $dshCommand plugin --profile web add $pluginSpec 2>&1 | ForEach-Object { "    $_" }
  $profileFile = Join-Path $env:USERPROFILE '.dsh\profiles\web\package.json'
  $installed = $false
  try {
    $profile = Get-Content $profileFile -Raw | ConvertFrom-Json
    $installed = [bool]($profile.dependencies.PSObject.Properties.Name -contains 'dsh-plugin-desktop-mode')
  } catch { $installed = $false }
  if (-not $installed) {
    if ($pluginSpec -ne 'dsh-plugin-desktop-mode') { throw "插件安装后未出现在 profile 依赖里（$pluginSpec）" }
    # Only reachable with -FromNpm: the registry copy failed, so fall back to the
    # one in this archive rather than leaving the user without a plugin.
    Say '  从 npm 安装未生效，退回包内自带的插件…'
    & $dshCommand plugin --profile web add $bundledSpec 2>&1 | ForEach-Object { "    $_" }
  }
}

# ---------------------------------------------------------------- 自启 ----
$autostartCommand = "pwsh -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$InstallDir\tools\dsh-desktop.ps1`" start -Port $WebPort -DebugPort $DebugPort *> `"$InstallDir\logs\autostart.log`""
if ($SkipAutostart) {
  Say '  跳过开机自启（-SkipAutostart）'
} else {
  Say "  注册开机自启：HKCU\...\Run\$runValueName"
  if ($PSCmdlet.ShouldProcess($runKey, "写 $runValueName")) {
    New-Item -Path $runKey -Force | Out-Null
    New-ItemProperty -Path $runKey -Name $runValueName -Value $autostartCommand -PropertyType String -Force | Out-Null
  }
}

# ------------------------------------------------------------------ 验证 --
if ($PSCmdlet.ShouldProcess($InstallDir, '冒烟检查')) {
  $tool = Join-Path $InstallDir 'tools\bin\dsh-desktop-input.exe'
  if (Test-Path $tool) {
    $smoke = & $tool status --exe $resolvedShell 2>&1 | Select-Object -Last 1
    if ("$smoke" -match 'DSH_INPUT_SHELL_WINDOW_NOT_FOUND') {
      # The layer is not running yet (a fresh install, or -SkipStart), and the tool
      # can only identify the shell window while it exists. Not a failure — say so
      # instead of printing a JSON payload that reads like one.
      Say '  工具自检：宿主未运行，跳过（start 之后自然生效）'
    } else {
      Say "  工具自检：$smoke"
    }
  } else {
    Say '  提示：原生工具未随包提供，可运行 tools\build-input-helper.ps1 现场编译'
  }
}

if (-not $SkipStart -and $PSCmdlet.ShouldProcess($InstallDir, '立即启动桌面层')) {
  Say '  启动桌面层…'
  Start-Process -FilePath 'pwsh' -ArgumentList @(
    '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
    '-File', (Join-Path $InstallDir 'tools\dsh-desktop.ps1'), 'start', '-Port', "$WebPort", '-DebugPort', "$DebugPort"
  ) -RedirectStandardOutput (Join-Path $InstallDir 'logs\install-start.out.log') `
    -RedirectStandardError (Join-Path $InstallDir 'logs\install-start.err.log') -WindowStyle Hidden | Out-Null
}

Say ''
Say '完成。接下来：'
Say "  · 桌面应已是 DSH（挂件 + 点输入框即可打字）"
Say "  · 停止并恢复普通桌面：pwsh -File `"$InstallDir\tools\dsh-desktop.ps1`" stop"
Say "  · 挂件配置：$InstallDir\widgets.json（首次启动后生成）"
[pscustomobject]$plan | ConvertTo-Json -Compress
