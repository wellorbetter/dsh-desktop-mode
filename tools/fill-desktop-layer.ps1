#Requires -Version 7
<#
.SYNOPSIS
  Make the embedded DSH desktop layer fill the desktop exactly (no window frame).

.DESCRIPTION
  The shell reparents its main window into Explorer's SHELLDLL_DefView as a
  WS_CHILD window, but it only flips POPUP->CHILD: the window keeps
  WS_CAPTION | WS_THICKFRAME | WS_DLGFRAME | WS_BORDER, so the non-client frame
  eats the title bar and borders. Measured on this machine: the desktop view is
  2560x1440 while the embedded window's client area is only 2544x1401, which is
  the visible frame around the desktop.

  This tool strips those style bits, then sizes the window to the parent's client
  rect so the layer covers the whole desktop. It records the original style,
  extended style and rect in logs/desktop-layer-style.json; -Restore puts them
  back. Only window styles/geometry are touched — no process is started/stopped.

.PARAMETER WhatIf
  Report what would change and exit without modifying anything.

.PARAMETER Restore
  Re-apply the recorded original styles and geometry.

.EXAMPLE
  pwsh -File tools/fill-desktop-layer.ps1 -WhatIf
  pwsh -File tools/fill-desktop-layer.ps1
  pwsh -File tools/fill-desktop-layer.ps1 -Restore

  Prints one line of JSON. Exit code 1 when the embedded window cannot be found
  or the resize could not be verified.
#>
[CmdletBinding()]
param(
  [switch]$Restore,
  [switch]$WhatIf,
  [string]$StatePath,
  [string]$ShellExe
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot

# PowerShell variable names are case-insensitive, so the parameter and the local
# used below must not share a name — otherwise assigning the default clobbers the
# parameter before it is ever consulted (measured: config.json was never read).
# Resolution order: -ShellExe, then config.json (installed layout), then the repo
# default.
$shellExePath = $ShellExe
if (-not $shellExePath) {
  $hostConfigPath = Join-Path $projectRoot 'config.json'
  if (Test-Path $hostConfigPath) {
    try {
      $hostConfig = Get-Content $hostConfigPath -Raw | ConvertFrom-Json
      if ($hostConfig.shellExe) { $shellExePath = $hostConfig.shellExe }
    } catch { $shellExePath = $null }
  }
}
if (-not $shellExePath) { $shellExePath = Join-Path $projectRoot 'shell\app\DeepSeek Harness桌面版.exe' }
if (-not (Test-Path $shellExePath)) {
  [pscustomobject]@{ ok = $false; error = 'DSH_DESKTOP_SHELL_EXE_MISSING'; path = $shellExePath } | ConvertTo-Json -Compress
  exit 1
}
$shellExe = $shellExePath
$logDir = Join-Path $projectRoot 'logs'
if (-not $StatePath) { $StatePath = Join-Path $logDir 'desktop-layer-style.json' }
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

if (-not ('DshDesktopLayerFill' -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class DshDesktopLayerFill {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string className, string windowName);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder value, int maxCount);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public int dwFlags; }
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW", SetLastError=true)] static extern IntPtr GetWindowLongPtr64(IntPtr hWnd, int index);
  [DllImport("user32.dll", EntryPoint="GetWindowLongW", SetLastError=true)] static extern IntPtr GetWindowLong32(IntPtr hWnd, int index);
  [DllImport("user32.dll", EntryPoint="SetWindowLongPtrW", SetLastError=true)] static extern IntPtr SetWindowLongPtr64(IntPtr hWnd, int index, IntPtr value);
  [DllImport("user32.dll", EntryPoint="SetWindowLongW", SetLastError=true)] static extern IntPtr SetWindowLong32(IntPtr hWnd, int index, IntPtr value);
  public static IntPtr GetWindowLongPtr(IntPtr hWnd, int index) {
    return IntPtr.Size == 8 ? GetWindowLongPtr64(hWnd, index) : GetWindowLong32(hWnd, index);
  }
  public static IntPtr SetWindowLongPtr(IntPtr hWnd, int index, IntPtr value) {
    return IntPtr.Size == 8 ? SetWindowLongPtr64(hWnd, index, value) : SetWindowLong32(hWnd, index, value);
  }
  public static string ClassName(IntPtr hWnd) { var sb = new StringBuilder(256); GetClassName(hWnd, sb, 256); return sb.ToString(); }
  /** Search from C# so a real NULL window name is passed (PowerShell turns $null into ""). */
  public static IntPtr FindChildClass(IntPtr parent, string className) { return FindWindowEx(parent, IntPtr.Zero, className, null); }
}
"@
}

# Non-client frame that must go, plus the extended edges that draw a border.
$GWL_STYLE = -16
$GWL_EXSTYLE = -20
$WS_CAPTION = [int64]0x00C00000
$WS_THICKFRAME = [int64]0x00040000
$WS_DLGFRAME = [int64]0x00400000
$WS_BORDER = [int64]0x00800000
$WS_POPUP = [int64]0x80000000
$WS_CHILD = [int64]0x40000000
$WS_VISIBLE = [int64]0x10000000
$WS_EX_DLGMODALFRAME = [int64]0x00000001
$WS_EX_CLIENTEDGE = [int64]0x00000200
$WS_EX_WINDOWEDGE = [int64]0x00000100
$WS_EX_STATICEDGE = [int64]0x00020000
$SWP_NOZORDER = 0x0004
$SWP_NOACTIVATE = 0x0010
$SWP_FRAMECHANGED = 0x0020

[void][DshDesktopLayerFill]::SetThreadDpiAwarenessContext([IntPtr]::new([int64]-4))

# ---------------------------------------------------------------- discovery --
$defView = [IntPtr]::Zero
[void][DshDesktopLayerFill]::EnumWindows({
    param($top, $state)
    $view = [DshDesktopLayerFill]::FindChildClass($top, 'SHELLDLL_DefView')
    if ($view -ne [IntPtr]::Zero) { $script:defView = $view; return $false }
    return $true
  }, [IntPtr]::Zero)

if ($defView -eq [IntPtr]::Zero) {
  [pscustomobject]@{ ok = $false; error = 'DSH_DESKTOP_VIEW_NOT_FOUND' } | ConvertTo-Json -Compress
  exit 1
}

$target = [IntPtr]::Zero
$shellProcessIds = @(Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness桌面版.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.ExecutablePath -eq $shellExe } | ForEach-Object { [uint32]$_.ProcessId })

# The shell keeps small helper windows inside the desktop view too (a ~160x28
# desktop-controls overlay was measured), and a collapsed layer shows up as a
# tiny Chrome_WidgetWin_1 whose Chrome_RenderWidgetHostHWND child is still
# desktop-sized. Collect both, then take the largest: the desktop layer is either
# the frame window itself or the parent of the biggest content window.
$candidates = New-Object System.Collections.Generic.List[object]
[void][DshDesktopLayerFill]::EnumChildWindows($defView, {
    param($child, $state)
    $className = [DshDesktopLayerFill]::ClassName($child)
    $owner = [uint32]0
    [void][DshDesktopLayerFill]::GetWindowThreadProcessId($child, [ref]$owner)
    if ($script:shellProcessIds -notcontains $owner) { return $true }

    $candidate = $child
    if ($className -eq 'Chrome_RenderWidgetHostHWND') {
      # The layer window is this content window's parent.
      $candidate = [DshDesktopLayerFill]::GetParent($child)
      if ($candidate -eq [IntPtr]::Zero) { return $true }
    } elseif ($className -ne 'Chrome_WidgetWin_1') {
      return $true
    }

    $rect = New-Object DshDesktopLayerFill+RECT
    [void][DshDesktopLayerFill]::GetWindowRect($candidate, [ref]$rect)
    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    if ($script:candidates | Where-Object { $_.handle -eq $candidate }) { return $true }
    $script:candidates.Add([pscustomobject]@{
        handle = $candidate
        role   = if ($className -eq 'Chrome_RenderWidgetHostHWND') { 'content-parent' } else { 'frame' }
        width  = $width
        height = $height
        area   = [int64]$width * [int64]$height
      })
    return $true
  }, [IntPtr]::Zero)

if ($candidates.Count -eq 0) {
  # Not embedded (e.g. already popped out for typing): fall back to the shell's
  # own top-level window so -Restore can still put the frame back.
  [void][DshDesktopLayerFill]::EnumWindows({
      param($top, $state)
      $owner = [uint32]0
      [void][DshDesktopLayerFill]::GetWindowThreadProcessId($top, [ref]$owner)
      if ($script:shellProcessIds -notcontains $owner) { return $true }
      if ([DshDesktopLayerFill]::ClassName($top) -ne 'Chrome_WidgetWin_1') { return $true }
      $rect = New-Object DshDesktopLayerFill+RECT
      [void][DshDesktopLayerFill]::GetWindowRect($top, [ref]$rect)
      $width = $rect.Right - $rect.Left
      $height = $rect.Bottom - $rect.Top
      if ($width -lt 200 -or $height -lt 200) { return $true }
      $script:candidates.Add([pscustomobject]@{
          handle = $top
          role   = 'top-level'
          width  = $width
          height = $height
          area   = [int64]$width * [int64]$height
        })
      return $true
    }, [IntPtr]::Zero)
}

if ($candidates.Count -eq 0) {
  [pscustomobject]@{ ok = $false; error = 'DSH_DESKTOP_WINDOW_NOT_FOUND'; detail = 'is the shell running, and is it the patched copy?' } | ConvertTo-Json -Compress
  exit 1
}
$chosen = $candidates | Sort-Object -Property area -Descending | Select-Object -First 1
$target = $chosen.handle
$otherCandidates = @($candidates | Where-Object { $_.handle -ne $target } | ForEach-Object { @{ handle = ('0x{0:X8}' -f $_.handle.ToInt64()); role = $_.role; size = "$($_.width)x$($_.height)" } })

# ------------------------------------------------------------ measurements --
$parentRect = New-Object DshDesktopLayerFill+RECT
$parentClient = New-Object DshDesktopLayerFill+RECT
$windowRect = New-Object DshDesktopLayerFill+RECT
$windowClient = New-Object DshDesktopLayerFill+RECT
[void][DshDesktopLayerFill]::GetWindowRect($defView, [ref]$parentRect)
[void][DshDesktopLayerFill]::GetClientRect($defView, [ref]$parentClient)
[void][DshDesktopLayerFill]::GetWindowRect($target, [ref]$windowRect)
[void][DshDesktopLayerFill]::GetClientRect($target, [ref]$windowClient)

$style = [DshDesktopLayerFill]::GetWindowLongPtr($target, $GWL_STYLE).ToInt64()
$exStyle = [DshDesktopLayerFill]::GetWindowLongPtr($target, $GWL_EXSTYLE).ToInt64()

$parentSize = @{ width = $parentClient.Right - $parentClient.Left; height = $parentClient.Bottom - $parentClient.Top }
$before = @{
  style      = ('0x{0:X8}' -f $style)
  exStyle    = ('0x{0:X8}' -f $exStyle)
  windowRect = "$($windowRect.Right - $windowRect.Left)x$($windowRect.Bottom - $windowRect.Top)"
  clientSize = "$($windowClient.Right - $windowClient.Left)x$($windowClient.Bottom - $windowClient.Top)"
}

if ($Restore) {
  if (-not (Test-Path $StatePath)) {
    [pscustomobject]@{ ok = $false; error = 'DSH_DESKTOP_STYLE_STATE_MISSING'; path = $StatePath } | ConvertTo-Json -Compress
    exit 1
  }
  $saved = Get-Content $StatePath -Raw | ConvertFrom-Json
  if ($WhatIf) {
    [pscustomobject]@{ ok = $true; whatIf = $true; action = 'restore'; saved = $saved; before = $before } | ConvertTo-Json -Depth 6 -Compress
    exit 0
  }
  [void][DshDesktopLayerFill]::SetWindowLongPtr($target, $GWL_STYLE, [IntPtr]::new([int64]$saved.style))
  [void][DshDesktopLayerFill]::SetWindowLongPtr($target, $GWL_EXSTYLE, [IntPtr]::new([int64]$saved.exStyle))
  $rect = $saved.rect
  [void][DshDesktopLayerFill]::SetWindowPos($target, [IntPtr]::Zero, [int]$rect.x, [int]$rect.y, [int]$rect.width, [int]$rect.height, ($SWP_NOZORDER -bor $SWP_NOACTIVATE -bor $SWP_FRAMECHANGED))
  [pscustomobject]@{ ok = $true; action = 'restore'; before = $before } | ConvertTo-Json -Depth 6 -Compress
  exit 0
}

# Remove the non-client frame; keep it a visible child window pinned in place.
# A target that is not inside the desktop view is a layer popped out for typing:
# it must stay a top-level POPUP sized to its monitor. Forcing WS_CHILD onto a
# window with no parent would make it disappear, so the two cases are separate.
$promoted = ($chosen.role -eq 'top-level')
$monitorSize = $null
if ($promoted) {
  $monitor = [DshDesktopLayerFill]::MonitorFromWindow($target, 2)   # MONITOR_DEFAULTTONEAREST
  $info = New-Object DshDesktopLayerFill+MONITORINFO
  $info.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][DshDesktopLayerFill+MONITORINFO])
  if ($monitor -ne [IntPtr]::Zero -and [DshDesktopLayerFill]::GetMonitorInfo($monitor, [ref]$info)) {
    $monitorSize = @{ width = $info.rcMonitor.Right - $info.rcMonitor.Left; height = $info.rcMonitor.Bottom - $info.rcMonitor.Top; x = $info.rcMonitor.Left; y = $info.rcMonitor.Top }
  } else {
    $monitorSize = @{ width = [DshDesktopLayerFill]::GetSystemMetrics(0); height = [DshDesktopLayerFill]::GetSystemMetrics(1); x = 0; y = 0 }
  }
}

$newStyle = if ($promoted) {
  ($style -band (-bnot ($WS_CAPTION -bor $WS_THICKFRAME -bor $WS_DLGFRAME -bor $WS_BORDER -bor $WS_CHILD))) -bor $WS_POPUP -bor $WS_VISIBLE
} else {
  ($style -band (-bnot ($WS_CAPTION -bor $WS_THICKFRAME -bor $WS_DLGFRAME -bor $WS_BORDER -bor $WS_POPUP))) -bor $WS_CHILD -bor $WS_VISIBLE
}
$newExStyle = $exStyle -band (-bnot ($WS_EX_DLGMODALFRAME -bor $WS_EX_CLIENTEDGE -bor $WS_EX_WINDOWEDGE -bor $WS_EX_STATICEDGE))

$plan = @{
  ok            = $true
  whatIf        = [bool]$WhatIf
  target        = ('0x{0:X8}' -f $target.ToInt64())
  targetRole    = $chosen.role
  promoted      = $promoted
  otherCandidates = $otherCandidates
  parentClient  = if ($promoted) { "$($monitorSize.width)x$($monitorSize.height)" } else { "$($parentSize.width)x$($parentSize.height)" }
  before        = $before
  newStyle      = ('0x{0:X8}' -f $newStyle)
  newExStyle    = ('0x{0:X8}' -f $newExStyle)
}

if ($WhatIf) {
  [pscustomobject]$plan | ConvertTo-Json -Depth 6 -Compress
  exit 0
}

if (-not (Test-Path $StatePath)) {
  [pscustomobject]@{
    style   = $style
    exStyle = $exStyle
    rect    = @{ x = $windowRect.Left; y = $windowRect.Top; width = $windowRect.Right - $windowRect.Left; height = $windowRect.Bottom - $windowRect.Top }
  } | ConvertTo-Json -Depth 4 | Set-Content -Path $StatePath -Encoding utf8
}

[void][DshDesktopLayerFill]::SetWindowLongPtr($target, $GWL_STYLE, [IntPtr]::new([int64]$newStyle))
[void][DshDesktopLayerFill]::SetWindowLongPtr($target, $GWL_EXSTYLE, [IntPtr]::new([int64]$newExStyle))
# Inside the desktop view: position in the parent's client coordinates (origin
# 0,0). Popped out: position on the monitor, still rounded to the full size.
$targetX = if ($promoted) { $monitorSize.x } else { 0 }
$targetY = if ($promoted) { $monitorSize.y } else { 0 }
$targetWidth = if ($promoted) { $monitorSize.width } else { $parentSize.width }
$targetHeight = if ($promoted) { $monitorSize.height } else { $parentSize.height }
[void][DshDesktopLayerFill]::SetWindowPos($target, [IntPtr]::Zero, $targetX, $targetY, $targetWidth, $targetHeight, ($SWP_NOZORDER -bor $SWP_NOACTIVATE -bor $SWP_FRAMECHANGED))

$afterWindow = New-Object DshDesktopLayerFill+RECT
$afterClient = New-Object DshDesktopLayerFill+RECT
[void][DshDesktopLayerFill]::GetWindowRect($target, [ref]$afterWindow)
[void][DshDesktopLayerFill]::GetClientRect($target, [ref]$afterClient)

$after = @{
  style      = ('0x{0:X8}' -f [DshDesktopLayerFill]::GetWindowLongPtr($target, $GWL_STYLE).ToInt64())
  exStyle    = ('0x{0:X8}' -f [DshDesktopLayerFill]::GetWindowLongPtr($target, $GWL_EXSTYLE).ToInt64())
  windowRect = "$($afterWindow.Right - $afterWindow.Left)x$($afterWindow.Bottom - $afterWindow.Top)"
  clientSize = "$($afterClient.Right - $afterClient.Left)x$($afterClient.Bottom - $afterClient.Top)"
}

$expectedWidth = if ($promoted) { $monitorSize.width } else { $parentSize.width }
$expectedHeight = if ($promoted) { $monitorSize.height } else { $parentSize.height }
$fits = ($afterClient.Right - $afterClient.Left) -eq $expectedWidth -and ($afterClient.Bottom - $afterClient.Top) -eq $expectedHeight
$plan.after = $after
$plan.ok = [bool]$fits
if (-not $fits) { $plan.error = 'DSH_DESKTOP_LAYER_FILL_MISMATCH' }
[pscustomobject]$plan | ConvertTo-Json -Depth 6 -Compress
if (-not $fits) { exit 1 }

