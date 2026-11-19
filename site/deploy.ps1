# Deploys site/ to Cloudflare Workers. Builds in C:\Dev so wrangler's caches and
# .wrangler state stay out of the synced Nextcloud folder.
# Usage: .\site\deploy.ps1            deploy
#        .\site\deploy.ps1 login      sign in to Cloudflare once (opens a browser)
#        .\site\deploy.ps1 dev        local preview on http://localhost:8787
param([string]$Action = 'deploy')

$stage = 'C:\Dev\clanker-site'
$env:npm_config_cache = 'C:\Dev\tools\npm-cache'
$env:WRANGLER_SEND_METRICS = 'false'
# An inherited API token overrides the OAuth login (and blocks `login`), so ignore it for this process.
Remove-Item Env:CLOUDFLARE_API_TOKEN -ErrorAction SilentlyContinue

New-Item -ItemType Directory -Force -Path $stage | Out-Null
robocopy (Join-Path $PSScriptRoot '.') $stage /MIR /XD .wrangler node_modules /XF deploy.ps1 /NFL /NDL /NJH /NJS | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)" }

Push-Location -LiteralPath $stage
try { npx.cmd --yes wrangler@latest $Action } finally { Pop-Location }
