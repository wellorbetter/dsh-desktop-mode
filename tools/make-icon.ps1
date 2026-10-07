<#
  Generate the tray icon.

  The tray used to point at an .ico extracted from the third-party desktop app
  this layer hosts. That file cannot ship in an MIT release, so the icon is
  generated here instead and the result (tools/bin/dsh-desktop.ico) is committed:
  a build must not depend on a drawing tool being installed.

  Design: a desktop-layer mark — a screen with a clock on it, drawn at several
  sizes so Explorer can pick the right one for the tray, the taskbar and the
  notification area.

  Usage:
    pwsh -File tools/make-icon.ps1
#>
[CmdletBinding()]
param(
  [string]$OutFile = (Join-Path $PSScriptRoot 'bin\dsh-desktop.ico')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

# Sizes Windows actually asks for: notification area, taskbar, Alt-Tab, Explorer.
$sizes = @(16, 24, 32, 48, 64, 128, 256)

function New-IconBitmap([int]$size) {
  $bitmap = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)
    $scale = $size / 32.0
    $px = { param([double]$v) [single]([Math]::Round($v * $scale, 2)) }

    # Rounded tile background.
    $tile = New-Object System.Drawing.RectangleF((& $px 1), (& $px 1), (& $px 30), (& $px 30))
    $radius = (& $px 7)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $radius * 2
    $path.AddArc($tile.X, $tile.Y, $d, $d, 180, 90)
    $path.AddArc($tile.Right - $d, $tile.Y, $d, $d, 270, 90)
    $path.AddArc($tile.Right - $d, $tile.Bottom - $d, $d, $d, 0, 90)
    $path.AddArc($tile.X, $tile.Bottom - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
      $tile,
      [System.Drawing.Color]::FromArgb(255, 32, 44, 66),
      [System.Drawing.Color]::FromArgb(255, 14, 20, 32),
      [System.Drawing.Drawing2D.LinearGradientMode]::Vertical)
    $g.FillPath($brush, $path)

    # Clock face: reads as "time on the desktop" even at 16px.
    $faceSize = (& $px 19)
    $face = New-Object System.Drawing.RectangleF((& $px 6.5), (& $px 6.5), $faceSize, $faceSize)
    $faceBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 236, 244, 255))
    $g.FillEllipse($faceBrush, $face)

    $handPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 21, 94, 214), (& $px 2.2))
    $handPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $handPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $centre = New-Object System.Drawing.PointF((& $px 16), (& $px 16))
    $g.DrawLine($handPen, $centre, (New-Object System.Drawing.PointF((& $px 16), (& $px 9.5))))
    $g.DrawLine($handPen, $centre, (New-Object System.Drawing.PointF((& $px 21.5), (& $px 18.5))))

    if ($size -ge 32) {
      # Stand, only where there is room for it.
      $stand = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(210, 180, 200, 230))
      $g.FillRectangle($stand, (& $px 13), (& $px 26.4), (& $px 6), (& $px 1.6))
      $stand.Dispose()
    }

    $brush.Dispose(); $path.Dispose(); $faceBrush.Dispose(); $handPen.Dispose()
  } finally {
    $g.Dispose()
  }
  return $bitmap
}

# ICO container: header + one directory entry per image + the PNG payloads.
function ConvertTo-IcoByteArray([System.Collections.IEnumerable]$bitmaps) {
  $payloads = @()
  foreach ($bitmap in $bitmaps) {
    $stream = New-Object System.IO.MemoryStream
    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    $payloads += ,@($bitmap.Width, $bitmap.Height, $stream.ToArray())
    $stream.Dispose()
  }

  $out = New-Object System.IO.MemoryStream
  $writer = New-Object System.IO.BinaryWriter($out)
  $writer.Write([UInt16]0)                       # reserved
  $writer.Write([UInt16]1)                       # type: icon
  $writer.Write([UInt16]$payloads.Count)
  $offset = 6 + (16 * $payloads.Count)
  foreach ($entry in $payloads) {
    $width = [int]$entry[0]; $height = [int]$entry[1]; $bytes = [byte[]]$entry[2]
    $widthByte = 0; if ($width -lt 256) { $widthByte = $width }
    $heightByte = 0; if ($height -lt 256) { $heightByte = $height }
    $writer.Write([byte]$widthByte)
    $writer.Write([byte]$heightByte)
    $writer.Write([byte]0)                       # palette colours
    $writer.Write([byte]0)                       # reserved
    $writer.Write([UInt16]1)                     # colour planes
    $writer.Write([UInt16]32)                    # bits per pixel
    $writer.Write([UInt32]$bytes.Length)
    $writer.Write([UInt32]$offset)
    $offset += $bytes.Length
  }
  foreach ($entry in $payloads) { $writer.Write([byte[]]$entry[2]) }
  $writer.Flush()
  $result = $out.ToArray()
  $writer.Dispose(); $out.Dispose()
  return $result
}

$bitmaps = foreach ($size in $sizes) { New-IconBitmap $size }
$bytes = ConvertTo-IcoByteArray $bitmaps
foreach ($bitmap in $bitmaps) { $bitmap.Dispose() }

New-Item -ItemType Directory -Force -Path (Split-Path $OutFile -Parent) | Out-Null
[IO.File]::WriteAllBytes($OutFile, $bytes)

# Load it back the way Windows will, so a malformed container fails here.
$check = New-Object System.Drawing.Icon($OutFile)
Write-Host ("icon written: {0} ({1} bytes, {2} sizes, default {3}x{4})" -f $OutFile, $bytes.Length, $sizes.Count, $check.Width, $check.Height)
Write-Host ("sha256: {0}" -f (Get-FileHash $OutFile -Algorithm SHA256).Hash)
$check.Dispose()
