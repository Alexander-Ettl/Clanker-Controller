// Runs the Linux code paths against the real desktop (no fakes): notify, clipboard, keep-awake, media pause, tree kill.
//   node scripts/linux/system-check.cjs
// It pops one notification and puts a 8x8 red image on your clipboard. Works on X11 and Wayland; reading the notification back
// needs dunst, so on other desktops that line is informational.
const { execFileSync, spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = path.resolve(__dirname, '..', '..', 'ai-chat-panel');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-syscheck-'));
const { notifyReply } = require(root + '/lib/notify.js');
const { copyImageToClipboard } = require(root + '/lib/clipboard-image.js');
const { keepAwake } = require(root + '/lib/keep-awake.js');
const { MediaPause } = require(path.join(root, '..', 'voice-router', 'lib', 'media-pause.cjs'));
const { killTree } = require(root + '/lib/stream-engine.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (c) => { try { return execFileSync('sh', ['-c', c], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch (e) { return 'ERR ' + (e.stdout || '') + (e.stderr || ''); } };
const ok = (name, cond, extra = '') => console.log(cond ? 'PASS' : 'FAIL', name, extra);
(async () => {
  // 1. notification + chime
  notifyReply({ appName: 'Visual Studio Code', chime: true, toast: { agent: 'claude', text: 'The build is fixed. More detail follows.', chatTitle: 'Linux' } });
  await sleep(1500);
  if (!sh('command -v dunstctl').startsWith('ERR')) {
    const hist = sh('dunstctl history');
    ok('notify-send reached the notification daemon', /Claude replied/.test(hist) && /The build is fixed\./.test(hist), JSON.stringify(hist.slice(0, 160)));
  } else console.log('INFO  notification sent; this desktop has no dunstctl to read it back, so look for a "Claude replied" toast');
  // 2. image clipboard (Wayland via wl-copy, X11 via xclip)
  const pic = path.join(tmp, 'pic.png');
  fs.writeFileSync(pic, execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=8x8', '-frames:v', '1', '-f', 'image2', '-c:v', 'png', '-']));
  await copyImageToClipboard(pic);
  await sleep(300);
  const wayland = Boolean(process.env.WAYLAND_DISPLAY);
  const targets = sh(wayland ? 'wl-paste --list-types' : 'xclip -selection clipboard -t TARGETS -o');
  const bytes = wayland ? spawnSync('wl-paste', ['--type', 'image/png']).stdout : spawnSync('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']).stdout;
  ok('image on the clipboard (' + (wayland ? 'wayland' : 'x11') + ')', /image\/png/.test(targets) && bytes.slice(1, 4).toString() === 'PNG', targets.replace(/\n/g, ','));
  // 3. keep awake. The running editor may hold its own inhibitor, so count ours before and after.
  const held = () => (sh('systemd-inhibit --list --no-pager').match(/Clanker Controller/g) || []).length;
  const heldBefore = held();
  let changes = 0;
  const hold = keepAwake({ onChange: () => changes++ });
  await sleep(1500);
  ok('keep-awake active', hold.active === true, 'changes=' + changes);
  ok('inhibitor registered with systemd-logind', held() === heldBefore + 1, sh('systemd-inhibit --list --no-pager').split('\n').find((l) => /Clanker/.test(l)) || '');
  hold.release();
  await sleep(1500);
  ok('inhibitor released', held() === heldBefore);
  ok('keep-awake leaves no watcher loop behind', sh(`pgrep -f '[k]ill -0 ${process.pid} ' | wc -l`) === '0', sh(`pgrep -af '[k]ill -0 ${process.pid} '`));
  // 4. media pause against a real MPRIS player on the session bus
  const player = spawn('python3', [path.join(__dirname, 'fake-mpris.py')], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((r) => player.stdout.once('data', r));
  const media = new MediaPause({ platform: 'linux' });
  const status = () => sh('busctl --user get-property org.mpris.MediaPlayer2.fakeplayer /org/mpris/MediaPlayer2 org.mpris.MediaPlayer2.Player PlaybackStatus');
  const before = status();
  const t0 = Date.now(); await media.pause(); const pauseMs = Date.now() - t0;
  const during = status();
  media.resume(); await sleep(600);
  const after = status();
  ok('media paused then resumed', /Playing/.test(before) && /Paused/.test(during) && /Playing/.test(after), `${before} -> ${during} -> ${after} (pause took ${pauseMs} ms)`);
  player.kill();
  // 5. tree kill: a "CLI" that started a grandchild, like a dev server run from a tool
  const cli = spawn('sh', ['-c', 'sh -c "sleep 300" & sleep 301'], { stdio: 'ignore' });
  await sleep(500);
  const alive = () => sh('pgrep -f "sleep 30[01]" | wc -l');
  const n0 = alive();
  killTree(cli);
  await sleep(800);
  ok('tree kill leaves no orphans', n0 >= 2 && alive() === '0', `before=${n0} after=${alive()}`);
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
