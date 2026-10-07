#Requires -Version 7
<#
.SYNOPSIS
  Run the DSH web UI as the Windows desktop layer (DSH 桌面载体).

.DESCRIPTION
  Wires together the three pieces this setup needs:

    1. a `dsh web` instance that this script owns, so the authentication token
       it prints at startup can be captured (the token is never persisted by
       DSH itself; GET / without it answers 401);
    2. the patched desktop shell (shell/app), started with that tokenised URL
       through DSH_DESKTOP_URL and with --remote-debugging-port so desktop mode
       can be driven from outside;
    3. the desktop-mode bridge call itself: the shell exposes desktop mode only
       through window.desktopWindow (Electron IPC), there is no CLI flag.

  Desktop icons are hidden by default because the desktop icon list window
  (SysListView32) is composited above the embedded window on Windows 11
  build 26200 — with icons shown, the DSH layer stays covered. Pass
  -WithIcons to keep them visible anyway.

  Failure containment: `start` verifies the bridge result and the rendered page
  before hiding icons, and rolls back (icons back, desktop mode off) if either
  check fails. `stop` always restores the icon list through
  tools/restore-desktop-icons.ps1, which works even when the shell is already
  dead — CDP alone cannot recover that case.

.EXAMPLE
  pwsh -File tools/dsh-desktop.ps1 start
  pwsh -File tools/dsh-desktop.ps1 start -WithIcons -NoTray
  pwsh -File tools/dsh-desktop.ps1 status
  pwsh -File tools/dsh-desktop.ps1 stop            # restore the normal desktop
  pwsh -File tools/dsh-desktop.ps1 restore-icons   # icons back, layer untouched
  pwsh -File tools/dsh-desktop.ps1 fill-check      # is the layer exactly screen-sized?
  pwsh -File tools/dsh-desktop.ps1 fill            # strip the window frame, fill the screen
  pwsh -File tools/dsh-desktop.ps1 fill-restore    # put the original window frame back
  pwsh -File tools/dsh-desktop.ps1 widgets-reload  # re-read config/widgets.json
  pwsh -File tools/dsh-desktop.ps1 widgets-off     # hide widgets (also across reloads)
  pwsh -File tools/dsh-desktop.ps1 install-autostart
  pwsh -File tools/dsh-desktop.ps1 uninstall       # autostart + stop + icons
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('start', 'stop', 'status', 'enable', 'disable', 'icons-on', 'icons-off', 'restore-icons', 'pop-out', 're-attach', 'typing-on', 'typing-off', 'typing-status', 'fill', 'fill-check', 'fill-restore', 'widgets-on', 'widgets-off', 'widgets-reload', 'widgets-resample', 'tray-reload', 'install-autostart', 'uninstall-autostart', 'uninstall')]
  [string]$Action = 'status',

  [int]$Port = 3081,
  [int]$DebugPort = 9222,

  # Keep desktop icons visible (the DSH layer will sit behind them).
  [switch]$WithIcons,

  # Do not start the tray control.
  [switch]$NoTray,

  # Leave the DSH first-run API-key dialog open.
  [switch]$KeepDialogs,

  # Leave the dsh web instance running on stop.
  [switch]$KeepWeb,

  # typing-on normally refuses unless the desktop already owns the foreground
  # (that is what a real click looks like, and it keeps a stray trigger from
  # stealing the keyboard from another app). -ForceTyping is for deliberate use
  # from a terminal, where the terminal is the foreground window.
  [switch]$ForceTyping,

  # Skip the freeze mask (the frozen last frame held over the composition swap,
  # i.e. the only double buffering that applies to leaving/entering the desktop
  # layer). Only useful for comparing the flicker by hand.
  [switch]$NoFreezeMask
)

$ErrorActionPreference = 'Stop'
# Without this, a failing node/curl exit code does NOT throw, and the failure
# branches below would be dead code.
$PSNativeCommandUseErrorActionPreference = $true

$projectRoot = Split-Path -Parent $PSScriptRoot
$shellExe = Join-Path $projectRoot 'shell\app\DeepSeek Harness桌面版.exe'

# Installed layout: the host package drops config.json next to this script's parent
# and the desktop app (the window host) lives wherever the user already had it, so
# it cannot be inferred from our own location any more. The repo layout has no such
# file and keeps the default above.
$hostConfigPath = Join-Path $projectRoot 'config.json'
$hostConfig = $null
if (Test-Path $hostConfigPath) {
  try { $hostConfig = Get-Content $hostConfigPath -Raw | ConvertFrom-Json } catch { $hostConfig = $null }
  if ($hostConfig -and $hostConfig.shellExe -and (Test-Path $hostConfig.shellExe)) { $shellExe = $hostConfig.shellExe }
}
$bridgeTool = Join-Path $projectRoot 'tools\desktop-mode.mjs'
$widgetTool = Join-Path $projectRoot 'tools\inject-widgets.mjs'
$daemonTool = Join-Path $projectRoot 'tools\widgets-daemon.mjs'
$daemonPidFile = Join-Path $projectRoot 'logs\widgets-daemon.pid'
$daemonLog = Join-Path $projectRoot 'logs\widgets-daemon.log'
$trayScript = Join-Path $PSScriptRoot 'dsh-desktop-tray.ps1'
$fillTool = Join-Path $PSScriptRoot 'fill-desktop-layer.ps1'
$inputTool = Join-Path $PSScriptRoot 'bin\dsh-desktop-input.exe'
$iconTool = Join-Path $PSScriptRoot 'restore-desktop-icons.ps1'
$widgetConfig = Join-Path $projectRoot 'config\widgets.json'
$logDir = Join-Path $projectRoot 'logs'
$webLog = Join-Path $logDir "dsh-web-$Port.log"
$webErrLog = Join-Path $logDir "dsh-web-$Port.err.log"
$urlFile = Join-Path $logDir "dsh-web-$Port.url"
$pidFile = Join-Path $logDir "dsh-web-$Port.pid"
$dshCommand = Join-Path $env:USERPROFILE '.local\bin\dsh.cmd'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runValueName = 'DshDesktopLayer'

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# Windows hands a child process the environment of whoever started it. This layer
# is routinely started from a context that is not the user's own shell (an agent
# session, a service, a scheduled task), and such environments are missing the
# user-scope variables. That is how a provider route which resolves its key from
# an environment variable — `apiKeyEnv: OPENCODE_GO_API_KEY` for the opencode-go
# route, `DEEPSEEK_API_KEY` for web search — fails at run time with
# MISSING_CREDENTIAL in the desktop instance while the very same profile works in
# the user's own browser.
#
# Copying the user's own variables in, exactly as Explorer would at logon, keeps
# every child this script starts working no matter who started the script. Only
# names that are missing here are added, so an explicitly-set value always wins,
# and values are never printed or logged.
function Import-UserEnvironment {
  $imported = New-Object System.Collections.Generic.List[string]
  try {
    $userValues = [Environment]::GetEnvironmentVariables([EnvironmentVariableTarget]::User)
  } catch {
    return $imported
  }
  foreach ($name in $userValues.Keys) {
    if ([string]::IsNullOrEmpty($name)) { continue }
    if (-not [string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($name, [EnvironmentVariableTarget]::Process))) { continue }
    $value = [Environment]::ExpandEnvironmentVariables([string]$userValues[$name])
    if ([string]::IsNullOrEmpty($value)) { continue }
    [Environment]::SetEnvironmentVariable($name, $value, [EnvironmentVariableTarget]::Process)
    $imported.Add($name)
  }
  return $imported
}

# Provider keys this profile resolves from the environment (names only).
$providerKeyNames = @('OPENCODE_GO_API_KEY', 'DEEPSEEK_API_KEY')
function Get-VisibleProviderKeys {
  @($providerKeyNames | Where-Object { -not [string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($_, [EnvironmentVariableTarget]::Process)) })
}
$importedEnv = @(Import-UserEnvironment)

# Start-Process switches to UseShellExecute=false as soon as any stream is
# redirected, and then the child inherits the handles that were NOT redirected —
# which keeps the caller's console/pipe open and makes an interactive shell hang
# long after the work is done. Long-lived children redirect all three streams.
function Start-DetachedProcess {
  param(
    [Parameter(Mandatory)][string]$FilePath,
    [string[]]$Arguments,
    [Parameter(Mandatory)][string]$StdOut,
    [Parameter(Mandatory)][string]$StdErr
  )
  $stdIn = Join-Path $logDir 'detached.stdin'
  if (-not (Test-Path $stdIn)) { New-Item -ItemType File -Path $stdIn -Force | Out-Null }
  $startArgs = @{
    FilePath               = $FilePath
    RedirectStandardOutput = $StdOut
    RedirectStandardError  = $StdErr
    RedirectStandardInput  = $stdIn
    WindowStyle            = 'Hidden'
    PassThru               = $true
  }
  if ($Arguments) { $startArgs.ArgumentList = $Arguments }
  return Start-Process @startArgs
}

function Test-IsOwnDshWeb {
  param($Process)
  if (-not $Process -or -not $Process.CommandLine) { return $false }
  return ($Process.CommandLine -match 'dsh') -and
         ($Process.CommandLine -match '\bweb\b') -and
         ($Process.CommandLine -match "--port\s+$Port(\s|$)")
}

function Get-DshWebProcess {
  $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $connection) { return $null }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($connection.OwningProcess)" -ErrorAction SilentlyContinue
  # Only ever claim / stop an instance this project started.
  if (Test-IsOwnDshWeb -Process $process) { return $process }
  return $null
}

# Electron runs one main process plus helpers that share the same executable, so
# only the roots (whose parent is not another copy) count as "the shell".
function Get-ShellProcess {
  $all = @(Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness桌面版.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -eq $shellExe })
  if ($all.Count -eq 0) { return @() }
  $ids = $all | ForEach-Object { $_.ProcessId }
  $roots = @($all | Where-Object { $ids -notcontains $_.ParentProcessId })
  if ($roots.Count -gt 0) { return $roots }
  return $all
}

function Get-ShellProcessAll {
  @(Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness桌面版.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -eq $shellExe })
}

function Test-WebUrl {
  param([string]$Url)
  if (-not $Url) { return $false }
  try {
    $code = (& curl.exe -s -o NUL -w '%{http_code}' --max-time 10 $Url)
    return $code -match '^(200|302|303|307)$'
  } catch {
    return $false
  }
}

function Get-WebUrl {
  param([switch]$Refresh)
  if (-not $Refresh -and (Test-Path $urlFile)) {
    $cached = (Get-Content $urlFile -Raw).Trim()
    if ($cached -and (Test-WebUrl -Url $cached)) { return $cached }
    Remove-Item $urlFile -ErrorAction SilentlyContinue
  }
  if (-not (Test-Path $webLog)) { return $null }
  $match = Select-String -Path $webLog -Pattern "http://127\.0\.0\.1:$Port/\?token=[A-Za-z0-9._~-]+" -AllMatches -ErrorAction SilentlyContinue
  if (-not $match) { return $null }
  $url = $match.Matches[-1].Value
  if (-not (Test-WebUrl -Url $url)) { return $null }
  Set-Content -Path $urlFile -Value $url -NoNewline -Encoding utf8
  return $url
}

function Start-DshWeb {
  $existing = Get-DshWebProcess
  if ($existing) {
    Write-Host "dsh web already listening on $Port (pid $($existing.ProcessId))"
    if (-not (Get-WebUrl)) { throw "a non-project process owns port $Port and no valid token URL is known" }
    return
  }
  if (-not (Test-Path $dshCommand)) { throw "dsh launcher not found: $dshCommand" }
  Remove-Item $urlFile, $pidFile -ErrorAction SilentlyContinue
  Write-Host "starting dsh web on port $Port …"
  $process = Start-DetachedProcess -FilePath $dshCommand -Arguments @('web', '--no-open', '--port', "$Port") `
    -StdOut $webLog -StdErr $webErrLog
  Set-Content -Path $pidFile -Value $process.Id -NoNewline -Encoding ascii
  for ($i = 0; $i -lt 90; $i++) {
    Start-Sleep -Seconds 1
    $url = Get-WebUrl
    if ($url) { Write-Host "dsh web ready: $($url.Substring(0, [Math]::Min(48, $url.Length)))…"; return }
  }
  throw "dsh web did not print a usable token URL within 90s (see $webLog)"
}

function Start-DesktopShell {
  $running = Get-ShellProcess
  if ($running) { Write-Host "desktop shell already running (pid $($running.ProcessId))"; return }
  $url = Get-WebUrl
  if (-not $url) { throw 'no authenticated dsh web URL yet' }
  if (-not (Test-Path $shellExe)) { throw "desktop shell not found: $shellExe" }
  Write-Host "launching desktop shell against port $Port …"
  $env:DSH_DESKTOP_URL = $url
  Start-DetachedProcess -FilePath $shellExe -Arguments @("--remote-debugging-port=$DebugPort") `
    -StdOut (Join-Path $logDir 'shell.out.log') -StdErr (Join-Path $logDir 'shell.err.log') | Out-Null
}

# Parse the JSON contract printed by the node tools. stdout should hold nothing
# but JSON; the fallback walks backwards for the last balanced object so that a
# stray note can never win over the payload.
function Get-LastJsonBlock {
  param([string]$Text)
  $end = $Text.LastIndexOf('}')
  while ($end -ge 0) {
    $depth = 0
    $inString = $false
    $escaped = $false
    for ($i = $end; $i -ge 0; $i--) {
      $ch = $Text[$i]
      if ($escaped) { $escaped = $false; continue }
      if ($ch -eq '\') { $escaped = $true; continue }
      if ($ch -eq '"') { $inString = -not $inString; continue }
      if ($inString) { continue }
      if ($ch -eq '}') { $depth++ }
      elseif ($ch -eq '{') {
        $depth--
        if ($depth -eq 0) { return $Text.Substring($i, $end - $i + 1) }
      }
    }
    $end = $Text.LastIndexOf('}', $end - 1)
  }
  return $null
}

function Convert-JsonOutput {
  param([string]$Text, [int]$ExitCode = 0)
  $trimmed = ($Text ?? '').Trim()
  if ($trimmed) {
    try { return $trimmed | ConvertFrom-Json } catch { }
    $candidate = Get-LastJsonBlock -Text $trimmed
    if ($candidate) {
      try { return $candidate | ConvertFrom-Json } catch { }
    }
  }
  return [pscustomobject]@{ raw = $trimmed; exitCode = $ExitCode }
}

# Run one of the node tools and return its parsed JSON. stderr is captured in a
# separate file (never merged into stdout) and the exit code is judged here, so
# -AllowFailure actually means "do not throw".
function Invoke-NodeTool {
  param([string]$Tool, [string[]]$ToolArgs, [switch]$AllowFailure)
  if (-not (Test-Path $Tool)) {
    if ($AllowFailure) { return $null }
    throw "tool not found: $Tool"
  }
  $errFile = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-node-err-" + [guid]::NewGuid().ToString('N') + ".log")
  $previousPreference = $PSNativeCommandUseErrorActionPreference
  $PSNativeCommandUseErrorActionPreference = $false
  try {
    $output = & node $Tool @ToolArgs 2>$errFile
    $exit = $LASTEXITCODE
    $stderr = if (Test-Path $errFile) { (Get-Content $errFile -Raw -ErrorAction SilentlyContinue) } else { '' }
  } finally {
    $PSNativeCommandUseErrorActionPreference = $previousPreference
    Remove-Item $errFile -Force -ErrorAction SilentlyContinue
  }
  $stdout = ($output | Out-String).Trim()
  if ($exit -ne 0 -and -not $AllowFailure) {
    throw "node $(Split-Path -Leaf $Tool) failed ($exit): $("$stderr".Trim()) $stdout"
  }
  return Convert-JsonOutput -Text $stdout -ExitCode $exit
}

# Runs the CDP bridge tool and returns its parsed JSON. Throws on a non-zero
# exit so callers cannot silently continue after a failed bridge call.
function Invoke-Bridge {
  param([string[]]$BridgeArgs, [switch]$AllowFailure)
  return Invoke-NodeTool -Tool $bridgeTool -ToolArgs ($BridgeArgs + @('--port', "$DebugPort")) -AllowFailure:$AllowFailure
}

# The fast native typing helper: leaving the desktop layer, taking the keyboard,
# and dropping back. Same JSON contract as the node tools.
function Invoke-InputTool {
  param([string[]]$ToolArgs, [switch]$AllowFailure)
  if (-not (Test-Path $inputTool)) {
    $rebuild = Join-Path $PSScriptRoot 'build-input-helper.ps1'
    if ($AllowFailure) { return [pscustomobject]@{ ok = $false; error = 'DSH_INPUT_HELPER_MISSING'; hint = "run $rebuild" } }
    throw "typing helper not built: $inputTool (run $rebuild)"
  }
  $errFile = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-input-err-" + [guid]::NewGuid().ToString('N') + ".log")
  $previousPreference = $PSNativeCommandUseErrorActionPreference
  $PSNativeCommandUseErrorActionPreference = $false
  try {
    # Always tell the helper which executable owns the window: installed under
    # %LOCALAPPDATA% it cannot infer that from its own location (measured:
    # DSH_INPUT_SHELL_WINDOW_NOT_FOUND).
    $output = & $inputTool @ToolArgs '--exe' $shellExe 2>$errFile
    $exit = $LASTEXITCODE
    $stderr = if (Test-Path $errFile) { (Get-Content $errFile -Raw -ErrorAction SilentlyContinue) } else { '' }
  } finally {
    $PSNativeCommandUseErrorActionPreference = $previousPreference
    Remove-Item $errFile -Force -ErrorAction SilentlyContinue
  }
  $stdout = ($output | Out-String).Trim()
  if ($exit -ne 0 -and -not $AllowFailure) {
    throw "dsh-desktop-input $($ToolArgs -join ' ') failed ($exit): $("$stderr".Trim()) $stdout"
  }
  return Convert-JsonOutput -Text $stdout -ExitCode $exit
}

# The real state of the layer, read from the OS instead of from what the shell
# believes: 'onDesktopLayer' is a parent-window fact and 'keyboard' means the
# shell window really would receive keystrokes right now.
function Get-TypingState {
  return Invoke-InputTool -ToolArgs @('status', '--root', $projectRoot) -AllowFailure
}

# Returns the shell to the desktop layer. Safe to call at any time: it is a
# no-op when the layer is already attached, and it is the guard against leaving
# the window parked outside the layer when a tool stops the daemon or the shell.
function Restore-TypingLayer {
  $state = Get-TypingState
  if ($null -eq $state -or $state.ok -ne $true) { return $state }
  if ($state.onDesktopLayer -eq $true) {
    if ($state.keyboard -eq $true) { Invoke-InputTool -ToolArgs @('demote', '--root', $projectRoot) -AllowFailure | Out-Null }
    return $state
  }
  return Invoke-InputTool -ToolArgs @('demote', '--root', $projectRoot) -AllowFailure
}

function Restore-DesktopIcons {
  $output = & pwsh -NoProfile -ExecutionPolicy Bypass -File $iconTool 2>&1
  $exit = $LASTEXITCODE
  $text = ($output | Out-String).Trim()
  $result = $null
  try { $result = $text | ConvertFrom-Json } catch { }
  if ($exit -eq 0 -and $result.visible) {
    Write-Host "desktop icons restored (list window $($result.desktopListWindowId))"
    return $true
  }
  Write-Warning "could not restore desktop icons: $text"
  return $false
}

# Hide Explorer's icon list with the same standalone tool. Doing it here instead
# of through the shell's IPC is what lets the shell stay unpatched: the icon list
# is Explorer's window, so nothing about it needs the app's cooperation.
function Hide-DesktopIcons {
  $output = & pwsh -NoProfile -ExecutionPolicy Bypass -File $iconTool -Hide 2>&1
  $exit = $LASTEXITCODE
  $text = ($output | Out-String).Trim()
  $result = $null
  try { $result = $text | ConvertFrom-Json } catch { }
  if ($exit -eq 0 -and $result.visible -eq $false) {
    Write-Host "desktop icons hidden (list window $($result.desktopListWindowId))"
    return $true
  }
  Write-Warning "could not hide desktop icons: $text"
  return $false
}

# The widget layer + typing trigger are now owned by the DSH plugin
# (dsh-plugin-desktop-mode): it serves them as ordinary page assets, so the CDP
# injection daemon is no longer part of the normal path. The daemon stays as an
# explicit opt-in (widgets-on) for comparing against the legacy behaviour.
function Test-DesktopPluginInstalled {
  $profile = Join-Path $env:USERPROFILE '.dsh\profiles\web\package.json'
  if (-not (Test-Path $profile)) { return $false }
  try {
    $json = Get-Content $profile -Raw | ConvertFrom-Json
    return [bool]($json.dependencies.PSObject.Properties.Name -contains 'dsh-plugin-desktop-mode')
  } catch {
    return $false
  }
}

# The widget layer (clock / weather / caption / theme / fps) in the legacy path is
# injected into the page the shell renders; see tools/widgets-daemon.mjs.
function Invoke-Widgets {
  param([string]$Mode = 'apply', [switch]$AllowFailure)
  return Invoke-NodeTool -Tool $widgetTool -ToolArgs @('--mode', $Mode, '--port', "$DebugPort") -AllowFailure:$AllowFailure
}

# The desktop instance starts with no DeepSeek API key, so the page opens with a
# first-run modal that covers the desktop; this closes it (see the tool for what
# it is allowed to click).
function Invoke-OnboardingDismiss {
  if ($KeepDialogs) { return [pscustomobject]@{ found = $false; skipped = $true } }
  $tool = Join-Path $PSScriptRoot 'dismiss-onboarding.mjs'
  # Best effort by design: a dialog the tool cannot classify must never abort the
  # whole start path.
  $result = Invoke-NodeTool -Tool $tool -ToolArgs @('--port', "$DebugPort", '--timeout', '20000') -AllowFailure
  return $result
}

# The widget layer is kept alive by a daemon that holds the CDP session open:
# a Page.addScriptToEvaluateOnNewDocument registration dies with its session, so
# one-shot injection is lost on the next page reload.
function Get-WidgetDaemonProcess {
  # Identify daemons by command line, not only by the pid file: a daemon whose
  # launcher was killed keeps running (that is the point of detaching it) and
  # would otherwise stay invisible and keep re-injecting the layer.
  @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'widgets-daemon\.mjs' })
}

function Start-WidgetDaemon {
  $existing = @(Get-WidgetDaemonProcess)
  if ($existing.Count -gt 0) {
    $keep = $existing | Sort-Object CreationDate | Select-Object -First 1
    foreach ($extra in ($existing | Where-Object { $_.ProcessId -ne $keep.ProcessId })) {
      Write-Host "stopping duplicate widget daemon pid $($extra.ProcessId)"
      Stop-Process -Id $extra.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Set-Content -Path $daemonPidFile -Value $keep.ProcessId -NoNewline -Encoding ascii
    Write-Host "widget daemon already running (pid $($keep.ProcessId))"
    return $keep
  }
  if (-not (Test-Path $daemonTool)) { throw "widget daemon not found: $daemonTool" }
  $env:DSH_WIDGET_PORT = "$DebugPort"
  $process = Start-DetachedProcess -FilePath 'node' -Arguments @($daemonTool, '--port', "$DebugPort") `
    -StdOut (Join-Path $logDir 'widgets-daemon.out.log') -StdErr $daemonLog
  Set-Content -Path $daemonPidFile -Value $process.Id -NoNewline -Encoding ascii
  Write-Host "widget daemon started (pid $($process.Id))"
  return $process
}

function Stop-WidgetDaemon {
  $stopped = $false
  foreach ($process in @(Get-WidgetDaemonProcess | Where-Object { $_ })) {
    Write-Host "stopping widget daemon pid $($process.ProcessId)"
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    $stopped = $true
  }
  Remove-Item $daemonPidFile -Force -ErrorAction SilentlyContinue
  # Give the debug port a moment to release the closed CDP session before a new
  # daemon attaches.
  if ($stopped) { Start-Sleep -Milliseconds 700 }
}

# Read the widget layer's own state out of the page (mounted / visible / instance).
function Get-WidgetState {
  try {
    $page = Invoke-Bridge @('page', '--timeout', '20000') -AllowFailure
    if ($null -eq $page) { return $null }
    return $page.widgets
  } catch {
    return $null
  }
}

# Poll until the page reports a mounted widget layer (bounded, never hangs).
function Wait-WidgetState {
  param([int]$Attempts = 20, [int]$DelayMs = 500)
  for ($i = 0; $i -lt $Attempts; $i++) {
    Start-Sleep -Milliseconds $DelayMs
    $state = Get-WidgetState
    if ($state) { return $state }
  }
  return $null
}

# The shell reparents its window as a WS_CHILD but leaves the title bar/border
# styles on, so the client area is smaller than the desktop (measured 2544x1401
# on a 2560x1440 screen) and the leftover strip looks like a frame around the
# desktop. This strips the frame and sizes the window to the desktop view.
function Invoke-FillDesktopLayer {
  param([switch]$WhatIf, [switch]$Restore, [switch]$AllowFailure)
  if (-not (Test-Path $fillTool)) {
    if ($AllowFailure) { return $null }
    throw "fill tool not found: $fillTool"
  }
  $toolArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $fillTool)
  if ($WhatIf) { $toolArgs += '-WhatIf' }
  if ($Restore) { $toolArgs += '-Restore' }
  $errFile = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-fill-err-" + [guid]::NewGuid().ToString('N') + ".log")
  $previousPreference = $PSNativeCommandUseErrorActionPreference
  $PSNativeCommandUseErrorActionPreference = $false
  try {
    $output = & pwsh @toolArgs 2>$errFile
    $exit = $LASTEXITCODE
    $stderr = if (Test-Path $errFile) { (Get-Content $errFile -Raw -ErrorAction SilentlyContinue) } else { '' }
  } finally {
    $PSNativeCommandUseErrorActionPreference = $previousPreference
    Remove-Item $errFile -Force -ErrorAction SilentlyContinue
  }
  $stdout = ($output | Out-String).Trim()
  if ($exit -ne 0 -and -not $AllowFailure) {
    throw "fill-desktop-layer failed ($exit): $("$stderr".Trim()) $stdout"
  }
  return Convert-JsonOutput -Text $stdout -ExitCode $exit
}

function Get-WidgetConfig {
  if (-not (Test-Path $widgetConfig)) { return $null }
  try { return Get-Content $widgetConfig -Raw | ConvertFrom-Json } catch { return $null }
}

function Get-TrayProcess {
  # Require the -File argument so the query never matches a pwsh whose command
  # line merely mentions the tray script (e.g. an ad-hoc diagnostic).
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -in @('pwsh.exe', 'powershell.exe') -and $_.CommandLine -match '-File\s+"?[^"]*dsh-desktop-tray\.ps1' }
}

function Start-Tray {
  if ($NoTray) { return }
  if (Get-TrayProcess) { Write-Host 'tray already running'; return }
  if (-not (Test-Path $trayScript)) { Write-Warning "tray script not found: $trayScript"; return }
  Write-Host 'starting tray control …'
  # NotifyIcon needs an STA thread; pwsh -Sta gives one (and unlike Windows
  # PowerShell 5.1 it reads the script as UTF-8).
  Start-DetachedProcess -FilePath 'pwsh' `
    -Arguments @('-Sta', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $trayScript) `
    -StdOut (Join-Path $logDir 'tray.out.log') -StdErr (Join-Path $logDir 'tray.err.log') | Out-Null
  for ($i = 0; $i -lt 10; $i++) {
    Start-Sleep -Milliseconds 500
    if (Get-TrayProcess) { Write-Host "tray running (pid $((Get-TrayProcess | Select-Object -First 1).ProcessId))"; return }
  }
  Write-Warning 'tray process did not stay up'
}

function Stop-Tray {
  foreach ($process in @(Get-TrayProcess | Where-Object { $_ })) {
    Write-Host "stopping tray pid $($process.ProcessId)"
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

# Pin the shell window into Explorer's desktop view.
#
# This used to be a call into the shell's own desktop mode over Electron IPC,
# which is what forced us to patch the app: on this machine that code path is
# broken (its generated PowerShell passes $null to FindWindow, so Progman and the
# icon list are never found) and its IPC trust list only accepts origin :3080,
# while this layer is served from :3081. Our own native helper performs the same
# SetParent/WS_CHILD work from a process we control — the app is now just a
# window host and can stay byte-for-byte as shipped.
function Enable-DesktopLayer {
  # The shell is launched asynchronously, so its window may not exist yet when
  # this runs (the old IPC path blocked inside the app; our helper reports
  # "window not found" immediately instead). Wait for it.
  $attach = $null
  for ($i = 0; $i -lt 30; $i++) {
    $attach = Invoke-InputTool -ToolArgs @('demote', '--root', $projectRoot) -AllowFailure
    if ($attach -and $attach.ok -eq $true) { break }
    if ($i -eq 0) { Write-Host 'waiting for the shell window…' }
    Start-Sleep -Seconds 1
  }
  if (-not $attach -or $attach.ok -ne $true) {
    throw "could not pin the shell window to the desktop: $($attach | ConvertTo-Json -Compress)"
  }
  # The page-render check is our own CDP probe (not the shell's IPC): a freshly
  # launched shell may still be booting its plugin bundles.
  $page = $null
  for ($i = 0; $i -lt 30; $i++) {
    $page = Invoke-Bridge @('page', '--timeout', '20000') -AllowFailure
    if ($page -and $page.hasComposer -and $page.hasSidebar) { break }
    Start-Sleep -Seconds 1
  }
  if (-not $page -or -not $page.hasComposer -or -not $page.hasSidebar) {
    throw "the shell page is not rendering the DSH UI (href=$($page.href), title=$($page.title))"
  }
  Write-Host "desktop layer attached: $($attach.parentClass), page '$($page.title)'"
  return $attach
}

function Install-Autostart {
  $script = Join-Path $PSScriptRoot 'dsh-desktop.ps1'
  $icons = if ($WithIcons) { ' -WithIcons' } else { '' }
  $log = Join-Path $logDir 'autostart.log'
  $command = "pwsh -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`" start -Port $Port -DebugPort $DebugPort$icons *> `"$log`""
  New-Item -Path $runKey -Force | Out-Null
  New-ItemProperty -Path $runKey -Name $runValueName -Value $command -PropertyType String -Force | Out-Null
  Write-Host "autostart installed (HKCU\...\Run\$runValueName) — log: $log"
  Write-Host "  $command"
}

function Uninstall-Autostart {
  if (Get-ItemProperty -Path $runKey -Name $runValueName -ErrorAction SilentlyContinue) {
    Remove-ItemProperty -Path $runKey -Name $runValueName
    Write-Host "autostart removed ($runValueName)"
  } else {
    Write-Host 'autostart was not installed'
  }
}

function Stop-DesktopLayer {
  # No IPC call into the shell is needed to leave the desktop layer: the window
  # goes away with the shell process, and the icon list is Explorer's own window,
  # restored here by the same standalone tool (this is also the only path that
  # recovers a crashed shell that left the icons hidden).
  $iconsOk = Restore-DesktopIcons
  foreach ($process in (Get-ShellProcessAll)) {
    Write-Host "closing desktop shell pid $($process.ProcessId)"
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  }
  if (-not $KeepWeb) {
    $web = Get-DshWebProcess
    if ($web) {
      Write-Host "stopping dsh web pid $($web.ProcessId)"
      Stop-Process -Id $web.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Remove-Item $urlFile, $pidFile -ErrorAction SilentlyContinue
  }
  return $iconsOk
}

switch ($Action) {
  'start' {
    Start-DshWeb
    Start-DesktopShell
    try {
      Enable-DesktopLayer | Out-Null
      if (-not $WithIcons) {
        if (-not (Hide-DesktopIcons)) { throw 'desktop icons are still visible after the hide request' }
        Write-Host 'the DSH layer is always covered by the icon list otherwise'
      }
      # Cosmetic and non-fatal: never roll the layer back over a geometry tweak.
      $fill = Invoke-FillDesktopLayer -AllowFailure
      if ($fill -and $fill.ok) {
        Write-Host "desktop layer fills the screen ($($fill.parentClient), client $($fill.after.clientSize))"
      } else {
        Write-Warning "desktop layer may not fill the screen: $($fill.error) $($fill.raw)"
      }
      $widgetConfig = Get-WidgetConfig
      if (Test-DesktopPluginInstalled) {
        # The plugin owns the widget layer and the typing trigger now; starting the
        # injection daemon as well would race it (the daemon's document-start
        # payload installs first and would win). Just confirm the plugin's layer
        # actually mounted in the page.
        $widgetState = Wait-WidgetState
        if ($null -eq $widgetState) {
          Write-Warning 'could not read the widget layer state; the plugin may still be loading'
        } elseif ($widgetState.mounted) {
          Write-Host "widget layer active via the plugin (instance $($widgetState.instanceId))"
        } elseif ($widgetConfig -and $widgetConfig.enabled) {
          throw "the plugin's widget layer did not mount (mounted=$($widgetState.mounted), visible=$($widgetState.visible))"
        }
      } else {
        Start-WidgetDaemon | Out-Null
        # The daemon registers + applies; give it a moment, then read the page's own
        # state instead of trusting the injector's stdout.
        $widgetState = Wait-WidgetState
        if ($null -eq $widgetState) {
          Write-Warning 'could not read the widget layer state; continuing'
        } elseif ($widgetState.mounted) {
          Write-Host "widget layer active (instance $($widgetState.instanceId))"
        } elseif ($widgetConfig -and $widgetConfig.enabled) {
          throw "widget layer did not mount (mounted=$($widgetState.mounted), visible=$($widgetState.visible))"
        } else {
          Write-Host 'widget layer disabled in config/widgets.json'
        }
      }
      $dialog = Invoke-OnboardingDismiss
      if ($dialog.found) {
        if ($dialog.clicked) { Write-Host "closed first-run dialog: $($dialog.label)" }
        else { Write-Host 'first-run dialog left open (-KeepDialogs)' }
      }
    } catch {
      Write-Warning "start failed, rolling back: $_"
      Restore-DesktopIcons | Out-Null
      try { Invoke-InputTool -ToolArgs @('detach', '--root', $projectRoot) -AllowFailure | Out-Null } catch { }
      throw
    }
    Start-Tray
    Write-Host 'DSH desktop layer is running. Undo with: stop-dsh-desktop.cmd'
  }
  'stop' {
    Restore-TypingLayer | Out-Null
    Stop-Tray
    Stop-WidgetDaemon
    if (-not (Stop-DesktopLayer)) { throw 'stop finished but the desktop icon list is still hidden' }
    Write-Host 'normal desktop restored'
  }
  'pop-out' {
    # Leave the desktop layer and take the keyboard. Our helper does both: the
    # window only has to stop being a child of Explorer's desktop view, because a
    # child window can never be the active window and Chromium refuses keys to an
    # inactive window (measured: merged input queues and a correct focus window
    # were not enough).
    $result = Invoke-InputTool -ToolArgs @('promote', '--root', $projectRoot, '--force') -AllowFailure
    if ($result.ok -ne $true) { throw "could not leave the desktop layer: $($result | ConvertTo-Json -Compress)" }
    Write-Host "popped out to a normal window — typing works now (keyboard: $($result.foreground))"
    Write-Host 'put it back with: re-attach-dsh-desktop.cmd'
  }
  're-attach' {
    $state = Restore-TypingLayer
    if ($state -and $state.ok -ne $true) { throw "could not put the layer back on the desktop: $($state | ConvertTo-Json -Compress)" }
    if (-not $WithIcons) { Hide-DesktopIcons | Out-Null }
    $fill = Invoke-FillDesktopLayer -AllowFailure
    if ($fill -and $fill.ok) { Write-Host "back on the desktop layer ($($fill.parentClient))" }
    else { Write-Warning "attached, but the layer may not fill the screen: $($fill.error)" }
  }
  'typing-on' {
    # Fast path for "click the desktop and type": stay fullscreen and frameless,
    # just leave the desktop layer and take the keyboard (~250ms with the freeze
    # mask, ~50ms without it).
    $promoteArgs = @('promote', '--root', $projectRoot)
    if ($ForceTyping) { $promoteArgs += '--force' }
    if ($NoFreezeMask) { $promoteArgs += '--no-mask' }
    $result = Invoke-InputTool -ToolArgs $promoteArgs -AllowFailure
    if ($result.ok -ne $true) { throw "typing mode failed: $($result | ConvertTo-Json -Compress)" }
    Write-Host "typing mode on ($($result.windowId), keyboard: $($result.foreground), freeze-mask: $($result.mask))"
  }
  'typing-off' {
    $demoteArgs = @('demote', '--root', $projectRoot)
    if ($NoFreezeMask) { $demoteArgs += '--no-mask' }
    $result = Invoke-InputTool -ToolArgs $demoteArgs -AllowFailure
    if ($result.ok -ne $true) { throw "returning to the desktop layer failed: $($result | ConvertTo-Json -Compress)" }
    Write-Host "back on the desktop layer ($($result.parentClass), client $($result.clientSize), freeze-mask: $($result.mask))"
  }
  'typing-status' { Get-TypingState | ConvertTo-Json -Depth 4 }
  'fill' {
    $result = Invoke-FillDesktopLayer
    if (-not $result.ok) { throw "desktop layer does not fill the screen: $($result | ConvertTo-Json -Compress)" }
    Write-Host "desktop layer fills $($result.parentClient) (client $($result.after.clientSize))"
  }
  'fill-restore' {
    $result = Invoke-FillDesktopLayer -Restore
    if (-not $result.ok) { throw "could not restore the original window frame: $($result | ConvertTo-Json -Compress)" }
    Write-Host 'original window frame restored'
  }
  'fill-check' {
    Invoke-FillDesktopLayer -WhatIf | ConvertTo-Json -Depth 6
  }
  'widgets-on' {    Start-WidgetDaemon | Out-Null
    $state = Wait-WidgetState
    if ($state -and -not $state.mounted) { throw 'widget layer did not mount' }
    Write-Host 'widget layer on'
  }
  'widgets-resample' {
    $result = Invoke-Widgets -Mode 'resample'
    if ($result.contrast) {
      Write-Host "widget layer resampled (palettes: $($result.contrast.palettes | ConvertTo-Json -Compress))"
    } else {
      Write-Host 'resample requested (page reported no contrast state yet)'
    }
  }
  'widgets-off' {
    Stop-WidgetDaemon
    Invoke-Widgets -Mode 'off' | Out-Null
    Write-Host 'widget layer off (stays off across reloads)'
  }
  'widgets-reload' {
    $daemon = Get-WidgetDaemonProcess
    if ($daemon) {
      # The daemon watches the files and re-applies within ~2s.
      Start-Sleep -Seconds 3
      $state = Get-WidgetState
      if ($null -eq $state) { throw 'widget layer state unreadable' }
      if (-not $state.mounted) { throw 'widget layer did not mount after reload' }
      Write-Host "widget layer reloaded by daemon (instance $($state.instanceId))"
    } else {
      $result = Invoke-Widgets -Mode 'apply'
      if ($null -eq $result.state) { throw "widget layer state unreadable: $($result.raw)" }
      if (-not $result.state.mounted) { throw "widget layer did not mount: $($result | ConvertTo-Json -Compress)" }
      Write-Host "widget layer reloaded (instance $($result.state.instanceId), no daemon running)"
    }
  }
  'restore-icons' {
    if (-not (Restore-DesktopIcons)) { throw 'could not restore the desktop icon list' }
  }
  'uninstall' {
    Uninstall-Autostart
    Restore-TypingLayer | Out-Null
    Stop-Tray
    Stop-WidgetDaemon
    if (-not (Stop-DesktopLayer)) { throw 'uninstall finished but the desktop icon list is still hidden' }
    Write-Host 'uninstalled: autostart removed and the normal desktop restored'
  }
  'status' {
    $web = Get-DshWebProcess
    $shell = Get-ShellProcess
    [pscustomobject]@{
      webPort   = $Port
      webPid    = $web.ProcessId
      webUrl    = Get-WebUrl
      shellPid  = ($shell | Select-Object -First 1).ProcessId
      trayPid   = (Get-TrayProcess | Select-Object -First 1).ProcessId
      widgetsPid = (Get-WidgetDaemonProcess | Select-Object -First 1).ProcessId
      autostart = [bool](Get-ItemProperty -Path $runKey -Name $runValueName -ErrorAction SilentlyContinue)
      providerKeys = (Get-VisibleProviderKeys) -join ', '
      envImported = $importedEnv.Count
      pluginInstalled = (Test-DesktopPluginInstalled)
    } | Format-List
    if ($shell) {
      # No shell IPC: the layer's real state comes from our own helper (parent
      # window, foreground, focus window), which is the only source that stays
      # correct whether or not the app is patched.
      $typing = Get-TypingState
      if ($typing -and $typing.ok -eq $true) {
        [pscustomobject]@{
          layerOnDesktop  = $typing.onDesktopLayer
          layerKeyboard   = $typing.keyboard
          layerParent     = $typing.parentClass
          foregroundClass = $typing.foregroundClass
        } | Format-List
      }
      $widgetState = Get-WidgetState
      if ($widgetState) {
        [pscustomobject]@{
          widgetsMounted = $widgetState.mounted
          widgetsVisible = $widgetState.visible
          widgetsInstance = $widgetState.instanceId
        } | Format-List
      }
    }
  }
  'install-autostart' { Install-Autostart }
  'uninstall-autostart' { Uninstall-Autostart }
  'tray-reload' {
    # Useful after touching the tray script or its icon: stop and start just the
    # tray, leaving the layer itself alone.
    Stop-Tray
    Start-Tray
  }
  'enable'  { Enable-DesktopLayer | Out-Null; Hide-DesktopIcons | Out-Null }
  'disable' { Invoke-InputTool -ToolArgs @('detach', '--root', $projectRoot) | Out-Null }
  'icons-on'  { if (-not (Restore-DesktopIcons)) { throw 'could not show the desktop icons' } }
  'icons-off' { if (-not (Hide-DesktopIcons)) { throw 'could not hide the desktop icons' } }
  default { throw "unhandled action: $Action" }
}




