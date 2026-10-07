#Requires -Version 7
<#
.SYNOPSIS
  Try to give the desktop-layer DSH window real keyboard focus without leaving the
  desktop layer, by merging input queues (AttachThreadInput).

.DESCRIPTION
  The DSH window is a WS_CHILD of Explorer's desktop view, so it is never the OS
  foreground window and keystrokes are not delivered to it. Windows only routes
  keyboard input to the foreground window's input queue, so the only way to keep
  the window embedded and still type is to attach its thread and the foreground
  thread to one queue, then SetFocus our window inside that merged queue:

      AttachThreadInput(helper, foregroundThread)
      AttachThreadInput(helper, shellThread)
      SetFocus(shellWindow)

  This is a documented-but-fragile technique: while the queues are merged, input
  handling of the other attached processes is affected, so the attach is released
  again when the grab window is over (-Release, starting a new grab, or the
  process being killed).

  Modes:
    -Status              read-only report (foreground window, focus, target)
    -Grab                attach + SetFocus, then stay resident until -Release
    -Release             stop a resident grabber and detach
    -SendTest "<text>"   type <text> as REAL OS keystrokes into whatever has focus
                         (only run this when the desktop layer is in front and no
                         game/tool is using the keyboard)

.EXAMPLE
  pwsh -File tools/grab-keyboard.ps1 -Status
  pwsh -File tools/grab-keyboard.ps1 -Grab
  pwsh -File tools/grab-keyboard.ps1 -SendTest "dsh typing test 123"
  pwsh -File tools/grab-keyboard.ps1 -Release
#>
[CmdletBinding()]
param(
  [switch]$Status,
  [switch]$Grab,
  [switch]$Release,
  [string]$SendTest,
  [string]$ShellExe
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $ShellExe) { $ShellExe = Join-Path $projectRoot 'shell\app\DeepSeek Harness桌面版.exe' }
$logDir = Join-Path $projectRoot 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$pidFile = Join-Path $logDir 'grab-keyboard.pid'

if (-not ('DshKeyboardGrab' -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class DshKeyboardGrab {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string className, string windowName);
  public static IntPtr FindChildClass(IntPtr parent, string className) { return FindWindowEx(parent, IntPtr.Zero, className, null); }
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder value, int maxCount);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder value, int maxCount);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetFocus();
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool attachFlag);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  public static string ClassName(IntPtr hWnd) { var sb = new StringBuilder(256); GetClassName(hWnd, sb, 256); return sb.ToString(); }
  public static string Title(IntPtr hWnd) { var sb = new StringBuilder(256); GetWindowText(hWnd, sb, 256); return sb.ToString(); }
  public static uint ThreadOf(IntPtr hWnd) { uint pid; return GetWindowThreadProcessId(hWnd, out pid); }
}
"@
}

function Get-ShellWindow {
  $script:shellProcessIds = @(Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness桌面版.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -eq $ShellExe } | ForEach-Object { [uint32]$_.ProcessId })
  if ($script:shellProcessIds.Count -eq 0) { return $null }
  # Delegate callbacks run in the script scope, so every shared variable is
  # $script:-qualified here.
  $script:best = $null
  $script:defView = [IntPtr]::Zero
  # While the layer is attached the window is a CHILD of Explorer's desktop view,
  # so search that subtree first; the top-level pass below covers the popped-out
  # state.
  [void][DshKeyboardGrab]::EnumWindows({
      param($top, $state)
      $view = [DshKeyboardGrab]::FindChildClass($top, 'SHELLDLL_DefView')
      if ($view -ne [IntPtr]::Zero) { $script:defView = $view; return $false }
      return $true
    }, [IntPtr]::Zero)
  if ($script:defView -ne [IntPtr]::Zero) {
    [void][DshKeyboardGrab]::EnumChildWindows($script:defView, {
        param($hWnd, $state)
        $owner = [uint32]0
        [void][DshKeyboardGrab]::GetWindowThreadProcessId($hWnd, [ref]$owner)
        if ($script:shellProcessIds -notcontains $owner) { return $true }
        if ([DshKeyboardGrab]::ClassName($hWnd) -ne 'Chrome_WidgetWin_1') { return $true }
        $rect = New-Object DshKeyboardGrab+RECT
        [void][DshKeyboardGrab]::GetWindowRect($hWnd, [ref]$rect)
        $width = $rect.Right - $rect.Left
        $height = $rect.Bottom - $rect.Top
        if ($width -lt 200 -or $height -lt 200) { return $true }
        $area = [int64]$width * [int64]$height
        if ($null -eq $script:best -or $area -gt $script:best.area) {
          $script:best = [pscustomobject]@{ handle = $hWnd; area = $area; width = $width; height = $height; role = 'embedded' }
        }
        return $true
      }, [IntPtr]::Zero)
  }
  if ($null -ne $script:best) { return $script:best }
  [void][DshKeyboardGrab]::EnumWindows({
      param($hWnd, $state)
      $owner = [uint32]0
      [void][DshKeyboardGrab]::GetWindowThreadProcessId($hWnd, [ref]$owner)
      if ($script:shellProcessIds -notcontains $owner) { return $true }
      if ([DshKeyboardGrab]::ClassName($hWnd) -ne 'Chrome_WidgetWin_1') { return $true }
      $rect = New-Object DshKeyboardGrab+RECT
      [void][DshKeyboardGrab]::GetWindowRect($hWnd, [ref]$rect)
      $width = $rect.Right - $rect.Left
      $height = $rect.Bottom - $rect.Top
      if ($width -lt 200 -or $height -lt 200) { return $true }
      $area = [int64]$width * [int64]$height
      if ($null -eq $script:best -or $area -gt $script:best.area) {
        $script:best = [pscustomobject]@{ handle = $hWnd; area = $area; width = $width; height = $height }
      }
      return $true
    }, [IntPtr]::Zero) | Out-Null
  return $script:best
}

function Get-ForegroundInfo {
  $fg = [DshKeyboardGrab]::GetForegroundWindow()
  [pscustomobject]@{
    handle = $fg
    code   = ('0x{0:X8}' -f $fg.ToInt64())
    class  = [DshKeyboardGrab]::ClassName($fg)
    title  = [DshKeyboardGrab]::Title($fg)
    thread = [DshKeyboardGrab]::ThreadOf($fg)
  }
}

function Get-ResidentGrabber {
  if (-not (Test-Path $pidFile)) { return $null }
  $id = (Get-Content $pidFile -Raw -ErrorAction SilentlyContinue).Trim()
  if (-not $id) { return $null }
  $process = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($process -and $process.ProcessName -in @('pwsh', 'powershell')) { return $process }
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  return $null
}

if ($Release) {
  $resident = Get-ResidentGrabber
  if ($resident) {
    Stop-Process -Id $resident.Id -Force -ErrorAction SilentlyContinue
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    [pscustomobject]@{ ok = $true; action = 'release'; stopped = $resident.Id } | ConvertTo-Json -Compress
  } else {
    [pscustomobject]@{ ok = $true; action = 'release'; stopped = $null } | ConvertTo-Json -Compress
  }
  exit 0
}

$shell = Get-ShellWindow
if ($null -eq $shell) {
  [pscustomobject]@{ ok = $false; error = 'DSH_SHELL_WINDOW_NOT_FOUND' } | ConvertTo-Json -Compress
  exit 1
}
$fg = Get-ForegroundInfo

if ($SendTest) {
  # Real OS keystrokes: they go to whatever currently has focus.
  $sent = 0
  foreach ($ch in $SendTest.ToCharArray()) {
    $code = [int][char]$ch
    if ($code -eq 32) { $vk = 0x20 }
    elseif ($code -ge 48 -and $code -le 57) { $vk = $code }
    elseif ($code -ge 65 -and $code -le 90) { $vk = $code }
    elseif ($code -ge 97 -and $code -le 122) { $vk = $code - 32 }
    else { continue }
    [DshKeyboardGrab]::keybd_event([byte]$vk, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 25
    [DshKeyboardGrab]::keybd_event([byte]$vk, 0, 2, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 25
    $sent += 1
  }
  [pscustomobject]@{ ok = $true; action = 'send-test'; characters = $sent; foreground = $fg } | ConvertTo-Json -Depth 4 -Compress
  exit 0
}

if ($Status) {
  $focus = [DshKeyboardGrab]::GetFocus()
  [pscustomobject]@{
    ok              = $true
    action          = 'status'
    shellWindow     = ('0x{0:X8}' -f $shell.handle.ToInt64())
    shellSize       = "$($shell.width)x$($shell.height)"
    shellThread     = [DshKeyboardGrab]::ThreadOf($shell.handle)
    foreground      = $fg
    focusWindow     = ('0x{0:X8}' -f $focus.ToInt64())
    focusIsShell    = $focus -eq $shell.handle
    residentGrabber = (Get-ResidentGrabber | Select-Object -First 1).Id
  } | ConvertTo-Json -Depth 4 -Compress
  exit 0
}

if (-not $Grab) {
  [pscustomobject]@{ ok = $false; error = 'NOTHING_TO_DO'; detail = 'pass -Status, -Grab, -Release or -SendTest <text>' } | ConvertTo-Json -Compress
  exit 1
}

# ---- Grab: merge our queue with the foreground thread and the shell thread ---
$current = [DshKeyboardGrab]::GetCurrentThreadId()
$attachedForeground = $false
$attachedShell = $false
if ($fg.thread -ne 0 -and $fg.thread -ne $current) {
  $attachedForeground = [DshKeyboardGrab]::AttachThreadInput($current, $fg.thread, $true)
}
if ($fg.thread -ne $shell.thread -and $shell.thread -ne $current) {
  $attachedShell = [DshKeyboardGrab]::AttachThreadInput($current, $shell.thread, $true)
}
[void][DshKeyboardGrab]::SetFocus($shell.handle)
Start-Sleep -Milliseconds 120
$focusAfter = [DshKeyboardGrab]::GetFocus()

[pscustomobject]@{
  ok                 = $true
  action             = 'grab'
  attachedForeground = $attachedForeground
  attachedShell      = $attachedShell
  foregroundThread   = $fg.thread
  shellThread        = $shell.thread
  focusIsShell       = $focusAfter -eq $shell.handle
  note               = 'resident until -Release; type now and check whether the input reaches the page'
} | ConvertTo-Json -Compress

Set-Content -Path $pidFile -Value $PID -NoNewline -Encoding ascii

# Stay resident so the queues stay merged while the user types.
try {
  while ($true) { Start-Sleep -Seconds 5 }
} finally {
  if ($attachedForeground) { [void][DshKeyboardGrab]::AttachThreadInput($current, $fg.thread, $false) }
  if ($attachedShell) { [void][DshKeyboardGrab]::AttachThreadInput($current, $shell.thread, $false) }
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}



