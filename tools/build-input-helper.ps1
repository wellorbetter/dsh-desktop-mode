#Requires -Version 7
<#
.SYNOPSIS
  Build the fast native typing helper (tools/bin/dsh-desktop-input.exe).

.DESCRIPTION
  The shell's desktop-mode transitions cost ~530 ms each because every step
  compiles C# through Add-Type. Typing needs the opposite: the layer must leave
  the desktop and take the keyboard in the time between the click and the first
  keystroke. This compiles the same Win32 work ahead of time with the in-box C#
  compiler, so a transition is a ~30 ms process start instead of a ~500 ms
  PowerShell + Add-Type round trip.

  The helper is a build artifact: tools/native/dsh-desktop-input.cs is the
  source of record, this script is the only thing that writes the exe.

.PARAMETER Force
  Rebuild even when the exe is newer than the source.

.EXAMPLE
  pwsh -File tools/build-input-helper.ps1
  Prints one line of JSON. Exit code 1 when compilation fails.
#>
[CmdletBinding()]
param(
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$sourcePath = Join-Path $PSScriptRoot 'native\dsh-desktop-input.cs'
$outputDir = Join-Path $PSScriptRoot 'bin'
$outputPath = Join-Path $outputDir 'dsh-desktop-input.exe'

if (-not (Test-Path $sourcePath)) {
  [pscustomobject]@{ ok = $false; error = 'DSH_INPUT_SOURCE_MISSING'; path = $sourcePath } | ConvertTo-Json -Compress
  exit 1
}

# The 64-bit in-box compiler: the shell and this machine are x64, and the
# INPUT struct used for synthetic keystrokes is layout-sensitive.
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) {
  [pscustomobject]@{ ok = $false; error = 'DSH_INPUT_COMPILER_MISSING'; path = $csc } | ConvertTo-Json -Compress
  exit 1
}

if (-not (Test-Path $outputDir)) { New-Item -ItemType Directory -Force -Path $outputDir | Out-Null }

$sourceTime = (Get-Item $sourcePath).LastWriteTimeUtc
$outputTime = if (Test-Path $outputPath) { (Get-Item $outputPath).LastWriteTimeUtc } else { [datetime]::MinValue }
if (-not $Force -and $outputTime -gt $sourceTime) {
  [pscustomobject]@{
    ok      = $true
    skipped = $true
    exe     = $outputPath
    builtAt = $outputTime.ToString('o')
  } | ConvertTo-Json -Compress
  exit 0
}

$stderrPath = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-input-build-{0}.err" -f ([guid]::NewGuid().ToString('n')))
$stdoutPath = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-input-build-{0}.out" -f ([guid]::NewGuid().ToString('n')))
$arguments = @(
  '/nologo',
  '/target:exe',
  '/platform:x64',
  '/optimize+',
  "/out:$outputPath",
  $sourcePath
)
$previous = $PSNativeCommandUseErrorActionPreference
$PSNativeCommandUseErrorActionPreference = $false
try {
  # csc writes compiler errors to stdout, and its default code page mangles the
  # localized text; /utf8output plus capturing both streams keeps the first real
  # error readable in the JSON we report.
  & $csc @arguments /utf8output > $stdoutPath 2> $stderrPath | Out-Null
  $exitCode = $LASTEXITCODE
} finally {
  $PSNativeCommandUseErrorActionPreference = $previous
}
$diagnostics = @()
foreach ($path in @($stdoutPath, $stderrPath)) {
  if (Test-Path $path) { $diagnostics += (Get-Content $path -Raw -Encoding utf8) }
  Remove-Item $path -ErrorAction SilentlyContinue
}
$diagnostics = $diagnostics -join "`n"

if ($exitCode -ne 0 -or -not (Test-Path $outputPath)) {
  [pscustomobject]@{
    ok      = $false
    error   = 'DSH_INPUT_BUILD_FAILED'
    exitCode = $exitCode
    detail  = ($diagnostics -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -First 6) -join ' | '
  } | ConvertTo-Json -Compress
  exit 1
}

$file = Get-Item $outputPath
[pscustomobject]@{
  ok        = $true
  skipped   = $false
  exe       = $file.FullName
  size      = $file.Length
  sha256    = (Get-FileHash $outputPath -Algorithm SHA256).Hash
  builtAt   = $file.LastWriteTimeUtc.ToString('o')
  compiler  = $csc
} | ConvertTo-Json -Compress
