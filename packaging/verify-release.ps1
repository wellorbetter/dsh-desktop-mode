<#
  Verify a release archive before it is published.

  `build-release.ps1` assembles the zip and asserts that no private content is
  *staged*. This script checks the artifact that would actually be handed out, by
  extracting it into a temporary directory and inspecting what came out:

    1. the zip matches the sha256 recorded in dist\SHA256SUMS.txt (a stale
       checksum file next to a fresh zip is exactly the kind of thing that ships);
    2. every file the installer and the launcher need is present;
    3. nothing private is present (shell/ logs/ state/ .evidence/ config/ dist/);
    4. no tracked text mentions a personal path, personal content or a credential;
    5. every shipped script parses (`node --check` for JS, the PowerShell parser
       for .ps1) and the widget-config contract still holds when loaded from the
       extracted copy rather than the working tree;
    6. only the two expected binaries (the native tool and the tray icon) are in it.

  Usage:
    pwsh -File packaging/verify-release.ps1                  # newest dist\*.zip
    pwsh -File packaging/verify-release.ps1 -Zip dist\x.zip
#>
[CmdletBinding()]
param(
  [string]$Zip = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$dist = Join-Path $root 'dist'

$failures = New-Object System.Collections.ArrayList
function Check([bool]$Condition, [string]$Message) {
  if ($Condition) {
    Write-Host "  ok    $Message"
  } else {
    Write-Host "  FAIL  $Message" -ForegroundColor Red
    $null = $failures.Add($Message)
  }
}

if ($Zip -eq '') {
  $candidate = Get-ChildItem $dist -Filter '*.zip' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($null -eq $candidate) { throw "no archive in $dist — run packaging\build-release.ps1 first" }
  $Zip = $candidate.FullName
}
if (-not (Test-Path $Zip)) { throw "no such archive: $Zip" }

$zipPath = (Resolve-Path $Zip).Path
$hash = (Get-FileHash $zipPath -Algorithm SHA256).Hash
Write-Host "verifying $zipPath"
Write-Host "  sha256 $hash"

# 1. The checksum file must describe this exact archive.
$sumsFile = Join-Path (Split-Path $zipPath -Parent) 'SHA256SUMS.txt'
if (Test-Path $sumsFile) {
  $sums = Get-Content $sumsFile -Raw
  Check ($sums -match [regex]::Escape($hash)) "dist\SHA256SUMS.txt records this archive's hash"
} else {
  Check $false 'dist\SHA256SUMS.txt exists'
}

# 2. Extract and inspect.
$temp = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-release-verify-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $temp | Out-Null
try {
  Expand-Archive -Path $zipPath -DestinationPath $temp -Force
  $files = Get-ChildItem $temp -Recurse -File
  $relative = $files | ForEach-Object { $_.FullName.Substring($temp.Length + 1).Replace('\', '/') }

  $required = @(
    'host/install.ps1', 'host/install.cmd', 'host/uninstall.ps1', 'host/uninstall.cmd',
    'tools/dsh-desktop.ps1', 'tools/dsh-desktop-tray.ps1', 'tools/fill-desktop-layer.ps1',
    'tools/restore-desktop-icons.ps1', 'tools/build-input-helper.ps1', 'tools/make-icon.ps1',
    'tools/native/dsh-desktop-input.cs', 'tools/bin/dsh-desktop-input.exe', 'tools/bin/dsh-desktop.ico',
    'plugin/package.json', 'plugin/cordis.patch.yml', 'plugin/lib/index.js', 'plugin/lib/client.js',
    'plugin/lib/typing.js', 'plugin/lib/settings-page.js', 'plugin/lib/widgets/widgets.js',
    'plugin/lib/widgets/widgets.css', 'plugin/lib/widgets/config.js', 'plugin/lib/widgets/default-config.json',
    'README.md', 'README.en.md', 'RELEASING.md', 'LICENSE'
  )
  $missing = $required | Where-Object { $relative -notcontains $_ }
  Check ($missing.Count -eq 0) "every file the installer and launcher need is present$(if ($missing.Count) { " (missing: $($missing -join ', '))" })"

  $forbidden = @('shell/', 'logs/', 'state/', '.evidence/', 'config/', 'dist/', 'node_modules/')
  $leaked = $forbidden | Where-Object { $prefix = $_; $relative | Where-Object { $_.StartsWith($prefix) } }
  Check ($leaked.Count -eq 0) "no private directory shipped$(if ($leaked.Count) { " (found: $($leaked -join ', '))" })"

  # 3. Content scan: personal paths, personal content, credentials.
  $textExtensions = @('.md', '.json', '.js', '.mjs', '.ps1', '.cmd', '.yml', '.yaml', '.cs', '.txt')
  $textFiles = $files | Where-Object { $textExtensions -contains $_.Extension.ToLower() }
  $patterns = @{
    'personal path'   = 'C:\\Users\\[A-Za-z0-9._-]+|D:\\DSH-Workspace'
    'credential'      = 'sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{20,}|PRIVATE KEY'
    'private content' = '夜莺|Bilibili|Before dawn|凌晨'
  }
  foreach ($name in $patterns.Keys) {
    $hits = @()
    foreach ($file in $textFiles) {
      $match = Select-String -Path $file.FullName -Pattern $patterns[$name] -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($match) { $hits += "$($file.FullName.Substring($temp.Length + 1)):$($match.LineNumber)" }
    }
    Check ($hits.Count -eq 0) "no $name in the archive$(if ($hits.Count) { " (found: $($hits -join ', '))" })"
  }

  # 4. Only the native tool and the tray icon are binaries.
  $binaries = $relative | Where-Object { $_ -match '\.(exe|dll|ico|png|zip|node)$' }
  $unexpected = $binaries | Where-Object { $_ -ne 'tools/bin/dsh-desktop-input.exe' -and $_ -ne 'tools/bin/dsh-desktop.ico' }
  Check ($unexpected.Count -eq 0) "only the native tool and the tray icon are binary$(if ($unexpected.Count) { " (found: $($unexpected -join ', '))" })"

  # 5. Everything parses, and the widget-config contract holds as shipped.
  $jsFiles = $relative | Where-Object { $_ -match '\.(js|mjs)$' }
  $jsFailed = @()
  foreach ($file in $jsFiles) {
    $full = Join-Path $temp ($file.Replace('/', '\'))
    $output = & node --check $full 2>&1
    if ($LASTEXITCODE -ne 0) { $jsFailed += $file; Write-Host "        $output" }
  }
  Check ($jsFailed.Count -eq 0) "every shipped JavaScript file parses ($($jsFiles.Count) files)$(if ($jsFailed.Count) { " (failed: $($jsFailed -join ', '))" })"

  $psFiles = $relative | Where-Object { $_ -match '\.ps1$' }
  $psFailed = @()
  foreach ($file in $psFiles) {
    $full = Join-Path $temp ($file.Replace('/', '\'))
    $tokens = $null; $errors = $null
    $null = [System.Management.Automation.Language.Parser]::ParseFile($full, [ref]$tokens, [ref]$errors)
    if ($errors -and $errors.Count -gt 0) { $psFailed += "$file ($($errors[0].Message))" }
  }
  Check ($psFailed.Count -eq 0) "every shipped PowerShell script parses ($($psFiles.Count) files)$(if ($psFailed.Count) { " (failed: $($psFailed -join '; '))" })"

  $contractScript = @'
import { normalize, DEFAULT_CONFIG, FIELDS } from './plugin/lib/widgets/config.js'
const hostile = { clock: { scale: 'huge', shadow: 'sparkly' }, enabled: 'maybe' }
const { config, issues } = normalize(hostile, DEFAULT_CONFIG)
if (issues.length < 3) throw new Error('hostile values were not reported')
if (typeof config.clock.scale !== 'number') throw new Error('scale was not repaired')
if (FIELDS.length < 40) throw new Error('field table looks truncated')
console.log('contract ok (' + FIELDS.length + ' fields)')
'@
  $contractPath = Join-Path $temp 'contract-check.mjs'
  Set-Content -Path $contractPath -Value $contractScript -Encoding utf8
  $contract = & node $contractPath 2>&1
  Check ($LASTEXITCODE -eq 0) "the widget-config contract holds in the extracted copy ($contract)"

  # 6. The plugin manifest declares a client bundle that exists.
  $manifest = Get-Content (Join-Path $temp 'plugin\package.json') -Raw | ConvertFrom-Json
  Check ($manifest.dsh.client.platform -eq 'web') 'plugin declares dsh.client.platform = web'
  $clientEntry = $manifest.exports.'./client'
  $clientPath = "plugin/$($clientEntry -replace '^\./', '')"
  Check ($relative -contains $clientPath) "plugin exports a client bundle that exists ($clientPath)"
  Check ((Test-Path (Join-Path $temp 'plugin\cordis.patch.yml'))) 'the plugin patch file ships'

  # 7. The installers actually run.
  #
  # Parsing is not enough: a statement accidentally merged into the previous line
  # still parses and still fails at run time (that happened once, and it shipped
  # into a staging zip that the parse-only gate happily approved). Both installers
  # are run in dry-run mode against a throwaway install directory.
  $throwaway = Join-Path $temp 'whatif-install'
  $installOut = & pwsh -NoProfile -File (Join-Path $temp 'host\install.ps1') -WhatIf -SkipStart -InstallDir $throwaway 2>&1
  Check ($LASTEXITCODE -eq 0) "host\install.ps1 -WhatIf runs (exit $LASTEXITCODE)$(if ($LASTEXITCODE -ne 0) { " - $($installOut | Select-Object -Last 2)" })"
  Check (($installOut -join "`n") -match 'shellExe') 'host\install.ps1 -WhatIf resolves a host app'
  $uninstallOut = & pwsh -NoProfile -File (Join-Path $temp 'host\uninstall.ps1') -WhatIf -InstallDir $throwaway 2>&1
  Check ($LASTEXITCODE -eq 0) "host\uninstall.ps1 -WhatIf runs (exit $LASTEXITCODE)$(if ($LASTEXITCODE -ne 0) { " - $($uninstallOut | Select-Object -Last 2)" })"
} finally {
  Remove-Item -Recurse -Force $temp -ErrorAction SilentlyContinue
}

Write-Host ''
if ($failures.Count -eq 0) {
  Write-Host "release archive verified: $([System.IO.Path]::GetFileName($zipPath))" -ForegroundColor Green
  exit 0
}
Write-Host "$($failures.Count) check(s) failed" -ForegroundColor Red
exit 1
