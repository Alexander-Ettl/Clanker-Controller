<#
.SYNOPSIS
  Gives this extension's sidebar views a fixed narrow width in Antigravity; every other view keeps the normal 170px minimum.
.DESCRIPTION
  Antigravity hard-codes the primary sidebar's 170px minimum in its bundled workbench file, and no
  setting or extension API changes it. This adds a small hook there: while one of the listed view
  containers is showing, the sidebar is locked to -Width pixels; switching to any other view (the
  Explorer, Search, ...) unlocks it and it returns to its previous width.
  The original file is kept beside it as workbench.desktop.main.js.orig (refreshed automatically
  when an IDE update replaces the file). An IDE update also removes the patch, so run this again
  after updating. Antigravity may show an "installation appears to be corrupt" notice afterwards,
  because the file no longer matches its checksum; it is safe to dismiss.
.PARAMETER Width
  The locked width for the listed containers, in pixels. Default 64.
.PARAMETER Containers
  View container ids (as written in package.json) that get the locked width.
.PARAMETER Restore
  Puts the original file back.
.PARAMETER File
  Override the workbench file (defaults to the per-user Antigravity IDE install).
#>
[CmdletBinding()]
param(
    [int]$Width = 64,
    [string[]]$Containers = @('aiChatPanel'),
    [switch]$Restore,
    [string]$File
)

$ErrorActionPreference = 'Stop'
if (-not $File) {
    $File = Join-Path $env:LOCALAPPDATA 'Programs\Antigravity IDE\resources\app\out\vs\workbench\workbench.desktop.main.js'
}
if (-not (Test-Path -LiteralPath $File)) { throw "Workbench file not found: $File" }
$backup = "$File.orig"

if ($Restore) {
    if (-not (Test-Path -LiteralPath $backup)) { throw "No backup to restore: $backup" }
    Copy-Item -LiteralPath $backup -Destination $File -Force
    Write-Host 'Restored the original workbench file. Reload the window.' -ForegroundColor Green
    return
}

# Bytes in, bytes out: a UTF-8 BOM (if the file has one) survives the round trip.
$utf8 = New-Object System.Text.UTF8Encoding($false)
$read = { param($path) $utf8.GetString([System.IO.File]::ReadAllBytes($path)) }

# The side bar part is the only one that lists these fields in this order.
$anchor = 'this.minimumWidth=170,this.maximumWidth=Number.POSITIVE_INFINITY,this.minimumHeight=0,this.maximumHeight=Number.POSITIVE_INFINITY,this.priority=1,'
$marker = '/*ave-sidebar*/'

$text = & $read $File
# Patched by this script (or its first version, which only changed the number): start again from the pristine copy.
$patchedBefore = $text.Contains($marker) -or [regex]::IsMatch($text, 'this\.minimumWidth=(?!170,)\d+,this\.maximumWidth=Number\.POSITIVE_INFINITY,this\.minimumHeight=0')
if ($patchedBefore) {
    if (-not (Test-Path -LiteralPath $backup)) { throw 'The file is patched but its .orig backup is missing. Nothing was modified.' }
    $pristine = & $read $backup
    # A backup from another IDE version would be a different file entirely: refuse to put that back.
    if ([math]::Abs($pristine.Length - $text.Length) -gt 20000) { throw 'The .orig backup does not match this IDE version. Nothing was modified.' }
    $text = $pristine
}
if (-not $text.Contains($anchor)) { throw 'The sidebar constructor was not found: this IDE version changed. Nothing was modified.' }
if (([regex]::Matches($text, [regex]::Escape($anchor))).Count -ne 1) { throw 'Expected exactly one sidebar constructor. Nothing was modified.' }

# On every pane composite the sidebar opens: lock the width for ours, release it for the rest.
# Leaving a wide view remembers its width; coming back to one restores it (300 if never seen).
$pattern = '^workbench\.view\.extension\.(' + (($Containers | ForEach-Object { [regex]::Escape($_) }) -join '|') + ')$'
$hook = $marker + 'this._register(this.onDidPaneCompositeOpen(t=>{try{' +
    'const s=/' + $pattern.Replace('/', '\/') + '/.test(t.getId()),a=s?' + $Width + ':170;' +
    'if(a===this.minimumWidth)return;' +
    'const l=this.dimension?.width;s&&(this._aveWide=l);' +
    'this.minimumWidth=a,this.maximumWidth=s?' + $Width + ':Number.POSITIVE_INFINITY;' +
    'this.layoutService.resizePart("workbench.parts.sidebar",s?0:(this._aveWide||300)-(l||0),0)' +
    '}catch{}})),'

# Keep a pristine copy of the untouched file. This run's source is pristine by construction; a fresh
# IDE file (after an update) replaces an older backup.
if (-not $patchedBefore) { [System.IO.File]::WriteAllBytes($backup, $utf8.GetBytes($text)) }

[System.IO.File]::WriteAllBytes($File, $utf8.GetBytes($text.Replace($anchor, $anchor + $hook)))
Write-Host "Locked to $Width px for: $($Containers -join ', '). Everything else keeps 170 px. Reload the window (Developer: Reload Window)." -ForegroundColor Green
