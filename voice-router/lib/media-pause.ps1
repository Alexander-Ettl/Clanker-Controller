$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1

function Await-Operation($operation, [Type]$resultType) {
    $task = $asTask.MakeGenericMethod($resultType).Invoke($null, @($operation))
    if (-not $task.Wait(2000)) {
        $operation.Cancel()
        throw 'Media control timed out.'
    }
    return $task.GetAwaiter().GetResult()
}

$paused = [System.Collections.Generic.List[object]]::new()
try {
    $manager = Await-Operation ($managerType::RequestAsync()) $managerType
    foreach ($session in $manager.GetSessions()) {
        try {
            $info = $session.GetPlaybackInfo()
            if ($info.PlaybackStatus.ToString() -ne 'Playing' -or -not $info.Controls.IsPauseEnabled) { continue }
            $paused.Add($session)
            if (-not (Await-Operation ($session.TryPauseAsync()) ([bool]))) { [void]$paused.Remove($session) }
        } catch { # A closed or unresponsive player must not block dictation.
        }
    }
    [Console]::Out.Write("ready`n")
    [Console]::Out.Flush()
    # EOF also arrives if the parent process dies or the IDE reloads.
    [void][Console]::In.ReadLine()
} finally {
    foreach ($session in $paused) {
        try {
            if ($session.GetPlaybackInfo().PlaybackStatus.ToString() -eq 'Paused') {
                [void](Await-Operation ($session.TryPlayAsync()) ([bool]))
            }
        } catch { # The user may have closed the player while dictating.
        }
    }
}
