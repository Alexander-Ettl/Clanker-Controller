# Reports a global key combination as lines on stdout: "down" when it is fully held, "up" when it is released.
# Polls GetAsyncKeyState (no hook, no admin rights, the keys still reach the focused app). Started by
# lib/voice-hotkey.js with the combination's virtual-key codes; exits when the editor that started it is gone.
param(
  [Parameter(Mandatory)][int]$Key,
  [string]$Modifiers = '', # virtual-key codes, comma separated ("17,18")
  [int]$ParentPid = 0
)
$mods = @(if ($Modifiers) { $Modifiers.Split(',') | ForEach-Object { [int]$_ } })
Add-Type -Namespace Clanker -Name Keys -MemberDefinition '[DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);'
$held = { param($vk) ([Clanker.Keys]::GetAsyncKeyState($vk) -band 0x8000) -ne 0 }
$down = $false
$ticks = 0
while ($true) {
  $now = (& $held $Key) -and -not ($mods | Where-Object { -not (& $held $_) })
  if ($now -ne $down) {
    $down = $now
    [Console]::Out.WriteLine($(if ($down) { 'down' } else { 'up' }))
    [Console]::Out.Flush()
  }
  if ((++$ticks % 150 -eq 0) -and $ParentPid -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { exit }
  Start-Sleep -Milliseconds 15
}
