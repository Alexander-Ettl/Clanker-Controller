<#
  Reply-finished signal for the AI Chat Panel: an optional Windows toast, then
  the same completion chime the Claude, Codex and Antigravity hooks play
  (claude-config-sync skill). Inputs arrive as environment variables so reply
  text is never spliced into this script: CHAT_TOAST_TITLE, CHAT_TOAST_BODY
  (no title, no toast), CHAT_TOAST_ICON (PNG shown with the name),
  CHAT_APP_NAME (Start menu name of the running IDE, the fallback sender),
  CHAT_SOUND (mp3 path).
#>
$ErrorActionPreference = 'SilentlyContinue'

if ($env:CHAT_TOAST_TITLE) {
    try {
        # The toast names its sender by app ID. Registering our own under the user's classes gives it
        # the panel's name and icon (the documented route for apps without an installer package);
        # rewritten each time, so a moved icon path follows along.
        $appId = 'RavelBuilds.AIChatPanel'
        $key = "HKCU:\Software\Classes\AppUserModelId\$appId"
        try {
            New-Item -Path $key -Force -ErrorAction Stop | Out-Null
            New-ItemProperty -Path $key -Name DisplayName -Value 'AI Chat Panel' -PropertyType String -Force -ErrorAction Stop | Out-Null
            if ($env:CHAT_TOAST_ICON -and (Test-Path -LiteralPath $env:CHAT_TOAST_ICON)) {
                New-ItemProperty -Path $key -Name IconUri -Value $env:CHAT_TOAST_ICON -PropertyType String -Force -ErrorAction Stop | Out-Null
            }
        } catch {
            # No registry access: send as the running IDE, else as PowerShell.
            $appId = (Get-StartApps | Where-Object { $_.Name -eq $env:CHAT_APP_NAME } | Select-Object -First 1).AppID
            if (-not $appId) { $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe' }
        }
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
