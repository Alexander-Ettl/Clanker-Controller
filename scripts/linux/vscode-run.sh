#!/usr/bin/env bash
# Runs real VS Code under Xvfb with this checkout loaded as a development extension; screenshots go to /tmp/shots.
# Needs: code, Xvfb, xdotool and ImageMagick's `import` (sudo apt install xvfb xdotool imagemagick). Uses a throwaway profile.
set -u
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
rm -rf /tmp/vsc-ud /tmp/vsc-ext /tmp/shots; mkdir -p /tmp/shots /tmp/vsc-ud/User
cat > /tmp/vsc-ud/User/settings.json <<J
{"workbench.startupEditor":"none","telemetry.telemetryLevel":"off","update.mode":"none","window.restoreWindows":"none","security.workspace.trust.enabled":false,"workbench.tips.enabled":false}
J
pkill -f 'Xvfb :99' 2>/dev/null; pkill -f 'user-data-dir /tmp/vsc-ud' 2>/dev/null; sleep 1 # only our own Xvfb and the throwaway VS Code, never your session
export DISPLAY=:99
Xvfb :99 -screen 0 1600x1000x24 >/tmp/xvfb.log 2>&1 &
sleep 2
code --no-sandbox --disable-gpu --user-data-dir /tmp/vsc-ud --extensions-dir /tmp/vsc-ext \
  --extensionDevelopmentPath "$repo/ai-chat-panel" --skip-welcome --skip-release-notes \
  --disable-workspace-trust --log trace "$repo" >/tmp/code.out 2>&1 &
sleep 35
import -window root /tmp/shots/01-started.png
WID=$(xdotool search --onlyvisible --name "Visual Studio Code" | head -1); echo "window $WID"
xdotool key --clearmodifiers ctrl+shift+p; sleep 2
xdotool type --delay 60 "Clanker Controller:Open"; sleep 2
import -window root /tmp/shots/02-palette.png
xdotool key Return; sleep 8
import -window root /tmp/shots/03-opened.png
