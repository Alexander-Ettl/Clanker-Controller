<#
  Reply-finished signal for the AI Chat Panel: an optional Windows toast, then
  the same completion chime the Claude, Codex and Antigravity hooks play
  (claude-config-sync skill). Inputs arrive as environment variables so reply
  text is never spliced into this script: CHAT_TOAST_TITLE, CHAT_TOAST_BODY
  (no title, no toast), CHAT_APP_NAME (Start menu name of the running IDE, so
  the toast carries its name and icon), CHAT_SOUND (mp3 path).
#>
$ErrorActionPreference = 'SilentlyContinue'

if ($env:CHAT_TOAST_TITLE) {
    try {
        $appId = (Get-StartApps | Where-Object { $_.Name -eq $env:CHAT_APP_NAME } | Select-Object -First 1).AppID
        if (-not $appId) { $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe' }
        [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
        [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
        $title = [Security.SecurityElement]::Escape($env:CHAT_TOAST_TITLE)
        $body = [Security.SecurityElement]::Escape($env:CHAT_TOAST_BODY)
        # Silent: the chime below is the sound.
        $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
        $xml.LoadXml("<toast><visual><binding template=`"ToastGeneric`"><text>$title</text><text>$body</text></binding></visual><audio silent=`"true`"/></toast>")
        [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show((New-Object Windows.UI.Notifications.ToastNotification $xml))
    } catch { }
}

if ($env:CHAT_SOUND -and (Test-Path -LiteralPath $env:CHAT_SOUND)) {
    Add-Type -AssemblyName PresentationCore
    $player = New-Object System.Windows.Media.MediaPlayer
    $player.Open([Uri]$env:CHAT_SOUND)
    $player.Play()
    Start-Sleep -Milliseconds 2000
    $player.Close()
}
