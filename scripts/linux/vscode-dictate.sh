#!/usr/bin/env bash
# Dictates a 440 Hz test tone into the VS Code started by vscode-run.sh (virtual microphone through PipeWire/Pulse) and
# prints the recorded segments' levels. Needs xdotool, ImageMagick's `import` and ffmpeg.
set -u
export DISPLAY=:99
pgrep -f 'user-data-dir /tmp/vsc-ud' >/dev/null || { echo "VS Code not running"; exit 2; }
for m in $(pactl list short modules | grep module-pipe-source | cut -f1); do pactl unload-module $m; done
rm -f /tmp/tone.fifo
M=$(pactl load-module module-pipe-source source_name=tone_mic file=/tmp/tone.fifo format=s16le rate=16000 channels=1 source_properties=device.description=ToneMic)
pactl set-default-source tone_mic
ffmpeg -y -loglevel error -re -f lavfi -i "sine=frequency=440:sample_rate=16000" -ac 1 -f s16le /tmp/tone.fifo &
TONE=$!
sleep 1
palette() { xdotool key --clearmodifiers ctrl+shift+p; sleep 1.5; xdotool type --delay 50 "$1"; sleep 1.5; xdotool key Return; }
palette "Clanker Controller:Dictate"
sleep 4
import -window root /tmp/shots/04-recording.png
sleep 2
palette "Clanker Controller:Dictate"
sleep 8
import -window root /tmp/shots/05-stopped.png
kill $TONE 2>/dev/null; pactl unload-module $M
find /tmp/vsc-ud -name "seg-*.wav" -exec ls -l {} \; 
for f in $(find /tmp/vsc-ud -name "seg-*.wav" | head -3); do ffmpeg -hide_banner -i $f -af volumedetect -f null - 2>&1 | grep -E "Duration|mean_volume|max_volume"; done
find /tmp/vsc-ud -name "meta.json" | head -2 | xargs -r cat
