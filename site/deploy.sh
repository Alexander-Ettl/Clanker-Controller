#!/usr/bin/env bash
# Deploys site/ to Cloudflare Workers. Builds under ~/dev so wrangler's caches and
# .wrangler state stay out of the synced repo.
# Usage: site/deploy.sh            deploy
#        site/deploy.sh login      sign in to Cloudflare once (opens a browser)
#        site/deploy.sh dev        local preview on http://localhost:8787
set -euo pipefail
action="${1:-deploy}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
stage="${CLANKER_SITE_STAGE:-$HOME/dev/clanker-site}"
export npm_config_cache="${npm_config_cache:-$HOME/dev/tools/npm-cache}"
export WRANGLER_SEND_METRICS=false
# An inherited API token overrides the OAuth login (and blocks `login`), so ignore it for this process.
unset CLOUDFLARE_API_TOKEN

mkdir -p "$stage"
rsync -a --delete --exclude .wrangler --exclude node_modules --exclude deploy.ps1 --exclude deploy.sh "$here/" "$stage/"
cd "$stage"
exec npx --yes wrangler@latest "$action"
