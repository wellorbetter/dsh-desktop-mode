# DSH desktop layer tray control.
#
# Started by tools/dsh-desktop.ps1 as `pwsh -Sta -File …` (NotifyIcon wants an
# STA thread; pwsh provides one and, unlike Windows PowerShell 5.1, reads this
# file as UTF-8). Every action it triggers calls the PowerShell 7 launcher.

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'Stop'
$toolsDir = $PSScriptRoot
$projectRoot = Split-Path -Parent $toolsDir
$launcher = Join-Path $toolsDir 'dsh-desktop.ps1'
$iconTool = Join-Path $toolsDir 'restore-desktop-icons.ps1'
# The tray icon is our own copy under tools/bin: the shell now runs from the
# shipped app.asar, so there is no unpacked assets/ directory to read from (a
# missing file here silently left the tray with a blank default icon).
$iconPath = Join-Path $toolsDir 'bin\dsh-desktop.ico'
if (-not (Test-Path $iconPath)) {
  foreach ($candidate in @(
      (Join-Path $projectRoot 'shell\app\resources\app\assets\icon.ico'),
      (Join-Path $projectRoot 'logs\app-extracted-patched\assets\icon.ico')
    )) {
    if (Test-Path $candidate) { $iconPath = $candidate; break }
  }
}
$logPath = Join-Path $projectRoot 'logs\autostart.log'

function Invoke-Launcher {
  param([string[]]$Arguments)
  & pwsh -NoProfile -ExecutionPolicy Bypass -File $launcher @Arguments 2>&1 | Out-String
}

function Show-Balloon {
  param([string]$Title, [string]$Text, [System.Windows.Forms.ToolTipIcon]$Icon = 'Info')
  $notify.BalloonTipTitle = $Title
  $notify.BalloonTipText = ($Text -replace '\s+', ' ').Trim()
  if ($notify.BalloonTipText.Length -gt 240) { $notify.BalloonTipText = $notify.BalloonTipText.Substring(0, 240) + '…' }
  $notify.BalloonTipIcon = $Icon
  $notify.ShowBalloonTip(6000)
}

$notify = New-Object System.Windows.Forms.NotifyIcon
if (Test-Path $iconPath) { $notify.Icon = New-Object System.Drawing.Icon($iconPath) }
$notify.Text = 'DSH 桌面层'
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$statusItem = $menu.Items.Add('状态…')
$statusItem.add_Click({
  try {
    $output = Invoke-Launcher @('status')
    Show-Balloon -Title 'DSH 桌面层状态' -Text $output
  } catch { Show-Balloon -Title '状态查询失败' -Text "$_" -Icon Error }
})

$reloadItem = $menu.Items.Add('重载挂件（读 config/widgets.json）')
$reloadItem.add_Click({
  try {
    $output = Invoke-Launcher @('widgets-reload')
    Show-Balloon -Title '挂件已重载' -Text $output
  } catch { Show-Balloon -Title '挂件重载失败' -Text "$_" -Icon Error }
})

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

$showIconsItem = $menu.Items.Add('显示桌面图标')
$showIconsItem.add_Click({
  try {
    $output = & pwsh -NoProfile -ExecutionPolicy Bypass -File $iconTool 2>&1 | Out-String
    Show-Balloon -Title '桌面图标' -Text $output
  } catch { Show-Balloon -Title '恢复图标失败' -Text "$_" -Icon Error }
})

$hideIconsItem = $menu.Items.Add('隐藏桌面图标')
$hideIconsItem.add_Click({
  try {
    $output = & pwsh -NoProfile -ExecutionPolicy Bypass -File $iconTool -Hide 2>&1 | Out-String
    Show-Balloon -Title '桌面图标' -Text $output
  } catch { Show-Balloon -Title '隐藏图标失败' -Text "$_" -Icon Error }
})

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

# Typing needs the window off the desktop layer (a child of Explorer's desktop
# view can never own the keyboard). This is the fast path: the window keeps its
# fullscreen frameless look and just takes the keyboard. -ForceTyping because the
# tray menu itself owns the foreground while it is open.
$popOutItem = $menu.Items.Add('打字模式：离开桌面层（可输入）')
$popOutItem.add_Click({
  try {
    $output = Invoke-Launcher @('typing-on', '-ForceTyping')
    Show-Balloon -Title '已进入打字模式' -Text $output
  } catch { Show-Balloon -Title '进入打字模式失败' -Text "$_" -Icon Error }
})

$reAttachItem = $menu.Items.Add('回到桌面层（铺满桌面）')
$reAttachItem.add_Click({
  try {
    $output = Invoke-Launcher @('typing-off')
    Show-Balloon -Title '已回到桌面层' -Text $output
  } catch { Show-Balloon -Title '回到桌面层失败' -Text "$_" -Icon Error }
})

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

$stopItem = $menu.Items.Add('停止 DSH 桌面层（恢复普通桌面）')
$stopItem.add_Click({
  try {
    $output = Invoke-Launcher @('stop')
    Show-Balloon -Title '已恢复普通桌面' -Text $output
  } catch { Show-Balloon -Title '停止失败' -Text "$_" -Icon Error }
  Start-Sleep -Seconds 2
  $notify.Visible = $false
  [System.Windows.Forms.Application]::Exit()
})

$exitItem = $menu.Items.Add('只退出托盘（桌面层继续运行）')
$exitItem.add_Click({
  $notify.Visible = $false
  [System.Windows.Forms.Application]::Exit()
})

$notify.ContextMenuStrip = $menu
$notify.add_MouseClick({
  param($sender, $event)
  if ($event.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
    try { Show-Balloon -Title 'DSH 桌面层' -Text (Invoke-Launcher @('status')) }
    catch { Show-Balloon -Title '状态查询失败' -Text "$_" -Icon Error }
  }
})

Show-Balloon -Title 'DSH 桌面层已启动' -Text '右键托盘图标可恢复图标 / 重载挂件 / 停止桌面层。'
[System.Windows.Forms.Application]::Run()
$notify.Dispose()

