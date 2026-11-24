#!/usr/bin/env bash
# Installs or links the Clanker Controller extension into Antigravity IDE on Linux/macOS.
#   ./install-into-antigravity.sh            copy (or use the editor CLI)
#   ./install-into-antigravity.sh --link     symlink this folder for live development
#   ./install-into-antigravity.sh --dir <extensionsDir>
# The work is done by scripts/install-extension.mjs, which also writes extensions.json without a BOM.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$here/../scripts/install-extension.mjs" antigravity "$@"
