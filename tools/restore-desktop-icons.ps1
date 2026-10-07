#Requires -Version 7
<#
.SYNOPSIS
  Show (default) or hide (-Hide) Explorer's desktop icon list without the
  desktop shell.

.DESCRIPTION
  The desktop shell hides the icon list by calling ShowWindow(SysListView32,
  SW_HIDE) and can only undo that through its own bridge. If the shell crashes
  or is killed while the icons are hidden, the desktop is left with no icons and
  no shell left to ask, so this script does the lookup and the ShowWindow call
  itself.

  The window search happens in C# on purpose: PowerShell binds `$null` passed to
  a `string` parameter as an empty string, which would turn the title filter
  into "title must be empty" and match nothing (SysListView32's title is
  "FolderView").

  Prints one line of JSON. Exit code 1 when the icon list cannot be found.
#>
[CmdletBinding()]
param(
  # Hide the icon list again (used by the tray menu).
  [switch]$Hide
)

$ErrorActionPreference = 'Stop'

if (-not ('DshDesktopIconFix' -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class DshDesktopIconFix {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string className, string windowName);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  public static IntPtr FindChildClass(IntPtr parent, string className) {
    return FindWindowEx(parent, IntPtr.Zero, className, null);
  }
}
"@
}

$defView = [IntPtr]::Zero
$listView = [IntPtr]::Zero
$callback = [DshDesktopIconFix+EnumWindowsProc] {
  param([IntPtr]$top, [IntPtr]$state)
  $view = [DshDesktopIconFix]::FindChildClass($top, 'SHELLDLL_DefView')
  if ($view -eq [IntPtr]::Zero) { return $true }
  $list = [DshDesktopIconFix]::FindChildClass($view, 'SysListView32')
  if ($list -eq [IntPtr]::Zero) { return $true }
  $script:defView = $view
  $script:listView = $list
  return $false
}
[DshDesktopIconFix]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null

if ($listView -eq [IntPtr]::Zero) {
  [pscustomobject]@{ ok = $false; visible = $false; error = 'DSH_DESKTOP_ICON_HOST_NOT_FOUND' } | ConvertTo-Json -Compress
  exit 1
}

# ShowWindow returns the PREVIOUS visibility state, not success, so the result
# is verified with IsWindowVisible instead.
$wanted = -not $Hide
[DshDesktopIconFix]::ShowWindow($listView, $(if ($wanted) { 5 } else { 0 })) | Out-Null
$visible = [DshDesktopIconFix]::IsWindowVisible($listView)
[pscustomobject]@{
  ok            = ($visible -eq $wanted)
  visible       = $visible
  requested     = $wanted
  desktopListWindowId = $listView.ToInt64().ToString()
  error         = if ($visible -eq $wanted) { '' } else { 'DSH_DESKTOP_ICON_VISIBILITY_FAILED' }
} | ConvertTo-Json -Compress
if ($visible -ne $wanted) { exit 1 }
