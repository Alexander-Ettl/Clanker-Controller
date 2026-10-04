<#
.SYNOPSIS
  Installs or links the Clanker Controller extension into Antigravity IDE.
.DESCRIPTION
  Safely installs the unpacked extension into Antigravity's extensions directory
  without introducing UTF-8 Byte Order Marks (BOM), and registers it in extensions.json.
.PARAMETER Link
  If specified, creates a Windows Directory Junction pointing to this source folder
  (ideal for live development).
.PARAMETER ExtensionsDir
  Override Antigravity's extensions directory. Defaults to ~/.antigravity-ide/extensions.
#>
[CmdletBinding()]
param(
    [switch]$Link,
    [string]$ExtensionsDir
)

$ErrorActionPreference = 'Stop'
$sourceDir = $PSScriptRoot
$pkgPath = Join-Path $sourceDir 'package.json'

if (-not (Test-Path -LiteralPath $pkgPath)) {
    throw "Extension manifest not found: $pkgPath"
}

# Read and validate manifest
$manifest = Get-Content -LiteralPath $pkgPath -Raw | ConvertFrom-Json
$extId = "$($manifest.publisher).$($manifest.name)"
$extFolder = "$($manifest.publisher).$($manifest.name)-$($manifest.version)"

if (-not $ExtensionsDir) {
    $ExtensionsDir = Join-Path $env:USERPROFILE '.antigravity-ide\extensions'
}
if (-not (Test-Path -LiteralPath $ExtensionsDir)) {
    New-Item -ItemType Directory -Path $ExtensionsDir -Force | Out-Null
}

$destination = Join-Path $ExtensionsDir $extFolder

if ($Link) {
    if (Test-Path -LiteralPath $destination) {
        $item = Get-Item -LiteralPath $destination
        if ($item.LinkType -eq 'Junction') {
            Write-Host "Junction already exists at: $destination" -ForegroundColor Yellow
        } else {
            Write-Host "Removing existing non-junction directory at: $destination" -ForegroundColor Yellow
            Remove-Item -LiteralPath $destination -Recurse -Force
            New-Item -ItemType Junction -Path $destination -Target $sourceDir | Out-Null
            Write-Host "Created Junction: $destination -> $sourceDir" -ForegroundColor Green
        }
    } else {
        New-Item -ItemType Junction -Path $destination -Target $sourceDir | Out-Null
        Write-Host "Created Junction: $destination -> $sourceDir" -ForegroundColor Green
    }
} else {
    if (-not (Test-Path -LiteralPath $destination)) {
        New-Item -ItemType Directory -Path $destination -Force | Out-Null
    }
    Get-ChildItem -LiteralPath $sourceDir -Force | Where-Object { $_.Name -notlike "*.ps1" } | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $destination -Recurse -Force
    }
    Write-Host "Copied extension files to: $destination" -ForegroundColor Green
}

# Update extensions.json safely using Node (ensures zero BOM and exact JSON schema)
$nodeScript = @'
const fs = require('fs');
const path = require('path');

const extDir = process.argv[2];
const extFolder = process.argv[3];
const extId = process.argv[4];
const extVersion = process.argv[5];

const registryPath = path.join(extDir, 'extensions.json');
let registry = [];
if (fs.existsSync(registryPath)) {
  try {
    registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  } catch (err) {
    console.error('Failed to parse extensions.json, starting fresh array:', err.message);
  }
}

const existingIdx = registry.findIndex(e => e.identifier?.id === extId);
const normalizedPath = '/' + path.join(extDir, extFolder).replace(/\\/g, '/');

const record = {
  identifier: { id: extId },
  version: extVersion,
  location: {
    $mid: 1,
    path: normalizedPath,
    scheme: 'file'
  },
  relativeLocation: extFolder
};

if (existingIdx !== -1) {
  registry[existingIdx] = record;
  console.log('Updated existing record in extensions.json for ' + extId);
} else {
  registry.push(record);
  console.log('Appended new record in extensions.json for ' + extId);
}

fs.writeFileSync(registryPath, JSON.stringify(registry), 'utf8');
'@

$nodeScript | node - "$ExtensionsDir" "$extFolder" "$extId" "$($manifest.version)"

# Verify via Antigravity CLI if present
$cliPath = Join-Path $env:LOCALAPPDATA 'Programs\Antigravity IDE\bin\antigravity-ide.cmd'
if (Test-Path -LiteralPath $cliPath) {
    Write-Host "Verifying with Antigravity CLI..." -ForegroundColor Cyan
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = 'SilentlyContinue'
    $list = & $cliPath --list-extensions 2>$null
    $ErrorActionPreference = $prevEAP
    if ($list -match [regex]::Escape($extId)) {
        Write-Host "SUCCESS: $extId is registered and recognized by Antigravity IDE." -ForegroundColor Green
    } else {
        Write-Warning "$extId was not found in 'antigravity-ide --list-extensions'."
    }
}

Write-Host "Done! Run 'Developer: Reload Window' in Antigravity to activate." -ForegroundColor Cyan
