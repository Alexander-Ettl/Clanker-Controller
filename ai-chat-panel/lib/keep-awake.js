'use strict';

const { spawn } = require('node:child_process');

// ES_CONTINUOUS | ES_SYSTEM_REQUIRED stays in force only while the calling thread lives, so a small helper
// process holds it and exits by itself if the IDE dies. Idle sleep is blocked; closing a laptop lid still sleeps.
const SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -Namespace Clanker -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'
if ([Clanker.Power]::SetThreadExecutionState([uint32]2147483649) -eq 0) { throw 'Windows rejected the sleep request' }
[Console]::Out.WriteLine('awake')
$parent = Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue
try { while ($parent -and -not $parent.HasExited) { Start-Sleep -Seconds 5; $parent.Refresh() } }
finally { [void][Clanker.Power]::SetThreadExecutionState([uint32]2147483648) }`;

function keepAwake({ platform = process.platform, spawnImpl = spawn, onChange = () => {}, onError = error => require('./log.js').warn('keep awake', error), retryMs = 5000, readyMs = 15000 } = {}) {
  if (platform !== 'win32') return null;
  let child, active = false, released = false, retry, timeout;
  const launch = () => {
    if (released) return;
    let failed = false, output = '';
    const fail = error => {
      if (failed || released) return;
      failed = true; active = false; clearTimeout(timeout);
      child?.kill(); onError(error); onChange();
      retry = setTimeout(launch, retryMs); retry.unref?.();
    };
    try {
      child = spawnImpl('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      child.stdout.on('data', data => {
        if (failed || released) return;
        output = (output + data).slice(-100);
        if (!active && /(?:^|\n)awake\r?\n/.test(output)) { active = true; clearTimeout(timeout); onChange(); }
      });
      child.once('error', fail);
      child.once('exit', code => fail(new Error(`Sleep helper exited (${code}); retrying`)));
      timeout = setTimeout(() => fail(new Error('Sleep helper did not confirm its request; retrying')), readyMs); timeout.unref?.();
      child.unref?.(); child.stdout.unref?.();
    } catch (error) { fail(error); }
  };
  launch();
  return { get active() { return active; }, release() {
    if (released) return;
    released = true; active = false; clearTimeout(retry); clearTimeout(timeout);
    if (child?.pid && child.exitCode === null) child.kill();
  } };
}

module.exports = { keepAwake };
