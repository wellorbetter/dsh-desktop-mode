#Requires -Version 7
<#
.SYNOPSIS
  Bring the DSH shell window to the front and give it keyboard focus.

.DESCRIPTION
  Used by `pop-out`, when the DSH window leaves the desktop layer and must become
  typable. `win.focus()` from Electron is not enough: Windows refuses
  SetForegroundWindow from a process that does not already own the foreground, so
  the classic AttachThreadInput dance is needed — attach to the thread of the
  current foreground window, then set ours, then detach.

  Only window focus is touched; nothing is started or stopped.

.EXAMPLE
  pwsh -File tools/focus-shell-window.ps1
  Prints one line of JSON. Exit code 1 when the window cannot be focused.
#>
[CmdletBinding()]
param(
  [string]$ShellExe
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $ShellExe) { $ShellExe = Join-Path $projectRoot 'shell\app\DeepSeek Harness桌面版.exe' }

if (-not ('DshShellFocus' -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class DshShellFocus {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder value, int maxCount);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool attachFlag);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  public static string ClassName(IntPtr hWnd) { var sb = new StringBuilder(256); GetClassName(hWnd, sb, 256); return sb.ToString(); }
  public static uint ThreadOf(IntPtr hWnd) { uint pid; return GetWindowThreadProcessId(hWnd, out pid); }
}
"@
}

$shellProcessIds = @(Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness桌面版.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.ExecutablePath -eq $ShellExe } | ForEach-Object { [uint32]$_.ProcessId })
if ($shellProcessIds.Count -eq 0) {
  [pscustomobject]@{ ok = $false; error = 'DSH_SHELL_NOT_RUNNING' } | ConvertTo-Json -Compress
  exit 1
}

$best = $null
[void][DshShellFocus]::EnumWindows({
    param($hWnd, $state)
    $owner = [uint32]0
    [void][DshShellFocus]::GetWindowThreadProcessId($hWnd, [ref]$owner)
    if ($script:shellProcessIds -notcontains $owner) { return $true }
    if ([DshShellFocus]::ClassName($hWnd) -ne 'Chrome_WidgetWin_1') { return $true }
    $rect = New-Object DshShellFocus+RECT
    [void][DshShellFocus]::GetWindowRect($hWnd, [ref]$rect)
    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    if ($width -lt 200 -or $height -lt 200) { return $true }
    $area = [int64]$width * [int64]$height
    if ($null -eq $script:best -or $area -gt $script:best.area) {
      $script:best = [pscustomobject]@{ handle = $hWnd; area = $area; width = $width; height = $height; visible = [DshShellFocus]::IsWindowVisible($hWnd) }
    }
    return $true
  }, [IntPtr]::Zero)

if ($null -eq $best) {
  [pscustomobject]@{ ok = $false; error = 'DSH_SHELL_WINDOW_NOT_FOUND' } | ConvertTo-Json -Compress
  exit 1
}

$target = $best.handle
[void][DshShellFocus]::ShowWindow($target, 9)     # SW_RESTORE
[void][DshShellFocus]::BringWindowToTop($target)

$foreground = [DshShellFocus]::GetForegroundWindow()
$currentThread = [DshShellFocus]::GetCurrentThreadId()
$foregroundThread = [DshShellFocus]::ThreadOf($foreground)
$targetThread = [DshShellFocus]::ThreadOf($target)

$attached = $false
if ($foregroundThread -ne 0 -and $foregroundThread -ne $currentThread) {
  $attached = [DshShellFocus]::AttachThreadInput($currentThread, $foregroundThread, $true)
}
try {
  [void][DshShellFocus]::SetForegroundWindow($target)
  [void][DshShellFocus]::SetFocus($target)
} finally {
  if ($attached) { [void][DshShellFocus]::AttachThreadInput($currentThread, $foregroundThread, $false) }
}

Start-Sleep -Milliseconds 150
$nowForeground = [DshShellFocus]::GetForegroundWindow()
$ok = $nowForeground -eq $target

[pscustomobject]@{
  ok              = $ok
  handle          = ('0x{0:X8}' -f $target.ToInt64())
  size            = "$($best.width)x$($best.height)"
  visible         = $best.visible
  foregroundMatch = $ok
  targetThread    = $targetThread
  error           = if ($ok) { '' } else { 'DSH_SHELL_FOCUS_FAILED' }
} | ConvertTo-Json -Compress
if (-not $ok) { exit 1 }
