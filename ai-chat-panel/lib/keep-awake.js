'use strict';

const { spawn } = require('node:child_process');

// ES_CONTINUOUS | ES_SYSTEM_REQUIRED stays in force only while the calling thread lives, so a small helper
// process holds it and exits by itself if the IDE dies. Idle sleep is blocked; closing a laptop lid still sleeps.
const SCRIPT = `Add-Type -Namespace Clanker -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'
[void][Clanker.Power]::SetThreadExecutionState([uint32]2147483649)
$parent = Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue
while ($parent -and -not $parent.HasExited) { Start-Sleep -Seconds 5 }`;

function keepAwake({ platform = process.platform, spawnImpl = spawn } = {}) {
  if (platform !== 'win32') return { release() {} };
  const child = spawnImpl('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')],
    { windowsHide: true, stdio: 'ignore' });
  child.on('error', () => {}); child.unref?.();
  return { release() { if (child.pid && child.exitCode === null) { try { child.kill(); } catch {} } } };
}

module.exports = { keepAwake };
