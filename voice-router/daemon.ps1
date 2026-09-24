<#
Voice Router background daemon.

Registers a global toggle hotkey (default Ctrl+Alt+Space). First press starts
recording from the configured microphone; second press stops it, runs the
recording through router.mjs (Groq Whisper -> cleanup/classification ->
quota-aware routing), and dispatches the result.

Dispatch safety rule: auto-paste + auto-submit (Enter) ONLY fires when a
window whose title matches daemon.config.json's windowTitles.<model> is
found and activated. If no matching window is open (e.g. Claude/Codex both
live inside one VS Code window with no distinguishing title), it falls back
to clipboard-only + a toast telling you where to paste — it never sends
Enter into an unidentified foreground window. When autoSubmit is on, there
is also a submitDelayMs grace window where pressing Esc cancels the send.

Run with:  powershell -File daemon.ps1
Stop it from the tray icon's right-click menu ("Exit"), or close the window.
#>

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName Microsoft.VisualBasic

$script:Root = $PSScriptRoot
$script:Config = Get-Content (Join-Path $script:Root 'daemon.config.json') -Raw | ConvertFrom-Json

$script:IsRecording = $false
$script:RecordingProcess = $null
$script:WavPath = $null

function Write-Log {
    param([string]$Message)
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] $Message"
}

# --- Tray icon + toast notifications ---------------------------------------

$script:TrayIcon = New-Object System.Windows.Forms.NotifyIcon
$script:TrayIcon.Icon = [System.Drawing.SystemIcons]::Information
$script:TrayIcon.Text = 'Voice Router'
$script:TrayIcon.Visible = $true

$script:TrayMenu = New-Object System.Windows.Forms.ContextMenuStrip
$exitItem = $script:TrayMenu.Items.Add('Exit')
$exitItem.Add_Click({
    $script:TrayIcon.Visible = $false
    [System.Windows.Forms.Application]::Exit()
})
$script:TrayIcon.ContextMenuStrip = $script:TrayMenu

function Show-Toast {
    param(
        [string]$Title,
        [string]$Message,
        [ValidateSet('Info', 'Warning', 'Error')][string]$Level = 'Info'
    )
    $script:TrayIcon.BalloonTipTitle = $Title
    $script:TrayIcon.BalloonTipText = $Message
    $script:TrayIcon.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::$Level
    $script:TrayIcon.ShowBalloonTip(4000)
    Write-Log "$Title -- $Message"
}

# --- Recording ---------------------------------------------------------------

function Start-Recording {
    param([string]$WavPath)

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $script:Config.ffmpegPath
    $psi.Arguments = "-y -loglevel error -f dshow -i `"audio=$($script:Config.micDevice)`" -ar 16000 -ac 1 `"$WavPath`""
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true

    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    [void]$proc.Start()
    # Drain async so ffmpeg never blocks on a full stdout/stderr pipe buffer.
    $proc.BeginOutputReadLine()
    $proc.BeginErrorReadLine()
    return $proc
}

function Stop-Recording {
    param($Process)

    try {
        $Process.StandardInput.Write('q')
        $Process.StandardInput.Flush()
    } catch {
        # ffmpeg may already be gone; fall through to the exit wait below.
    }

    $exited = $Process.WaitForExit(5000)
    if (-not $exited) {
        try { $Process.Kill() } catch {}
    }
}

# --- Pipeline ------------------------------------------------------------------

function Invoke-Router {
    param([string]$WavPath)

    $routerPath = Join-Path $script:Root 'router.mjs'
    $raw = & $script:Config.nodePath $routerPath '--audio' $WavPath '--json'
    if ($LASTEXITCODE -ne 0) {
        throw "router.mjs exited with code $LASTEXITCODE"
    }
    return ($raw -join "`n") | ConvertFrom-Json
}

# --- Window activation + dispatch ------------------------------------------

function Find-TargetWindow {
    param([string]$TitleSubstring)
    $procs = Get-Process | Where-Object {
        $_.MainWindowTitle -and $_.MainWindowTitle -like "*$TitleSubstring*"
    }
    if ($procs) { return $procs[0] }
    return $null
}

Add-Type -Namespace VoiceRouter -Name Keyboard -MemberDefinition @'
[DllImport("user32.dll")]
public static extern short GetAsyncKeyState(int vKey);
'@

function Wait-ForEscape {
    param([int]$DelayMs)
    $VK_ESCAPE = 0x1B
    $step = 50
    $elapsed = 0
    while ($elapsed -lt $DelayMs) {
        Start-Sleep -Milliseconds $step
        $elapsed += $step
        if ([VoiceRouter.Keyboard]::GetAsyncKeyState($VK_ESCAPE) -band 0x8000) {
            return $true
        }
    }
    return $false
}

function Send-ToTarget {
    param($Decision)

    $modelKey = $Decision.decision.targetModel
    $modelLabel = $modelKey.ToUpper()
    $titleSubstring = $script:Config.windowTitles.$modelKey

    if (-not $titleSubstring) {
        Show-Toast -Title "Routed to $modelLabel" -Message "$($Decision.decision.routingReason)`n`nCopied to clipboard." -Level Info
        return
    }

    $target = Find-TargetWindow -TitleSubstring $titleSubstring
    if (-not $target) {
        Show-Toast -Title "Routed to $modelLabel" -Message "Window '$titleSubstring' not open. Copied to clipboard -- paste manually." -Level Warning
        return
    }

    [Microsoft.VisualBasic.Interaction]::AppActivate($target.Id)
    Start-Sleep -Milliseconds 200
    [System.Windows.Forms.SendKeys]::SendWait('^v')

    if (-not $script:Config.autoSubmit) {
        Show-Toast -Title "Routed to $modelLabel" -Message 'Pasted into target window.' -Level Info
        return
    }

    $delaySeconds = [math]::Round($script:Config.submitDelayMs / 1000, 1)
    Show-Toast -Title "Sending to $modelLabel in ${delaySeconds}s" -Message 'Press Esc now to cancel.' -Level Info
    $cancelled = Wait-ForEscape -DelayMs $script:Config.submitDelayMs
    if ($cancelled) {
        Show-Toast -Title 'Cancelled' -Message 'Auto-submit cancelled -- prompt stayed pasted, not sent.' -Level Warning
        return
    }

    [Microsoft.VisualBasic.Interaction]::AppActivate($target.Id)
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
    Show-Toast -Title "Sent to $modelLabel" -Message $Decision.decision.routingReason -Level Info
}

# --- Toggle handler ----------------------------------------------------------

function Invoke-HotkeyToggle {
    if (-not $script:IsRecording) {
        $recordingsDir = Join-Path $script:Root $script:Config.recordingsDir
        if (-not (Test-Path $recordingsDir)) {
            New-Item -ItemType Directory -Path $recordingsDir | Out-Null
        }
        $script:WavPath = Join-Path $recordingsDir ("rec-{0}.wav" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))

        try {
            $script:RecordingProcess = Start-Recording -WavPath $script:WavPath
        } catch {
            Show-Toast -Title 'Voice Router error' -Message "Could not start ffmpeg: $($_.Exception.Message)" -Level Error
            return
        }
        $script:IsRecording = $true
        Show-Toast -Title 'Voice Router' -Message 'Recording... press the hotkey again to stop.' -Level Info
        return
    }

    $script:IsRecording = $false
    Stop-Recording -Process $script:RecordingProcess
    $script:RecordingProcess = $null

    try {
        $decision = Invoke-Router -WavPath $script:WavPath
    } catch {
        Show-Toast -Title 'Voice Router error' -Message $_.Exception.Message -Level Error
        return
    } finally {
        Remove-Item $script:WavPath -Force -ErrorAction SilentlyContinue
    }

    Send-ToTarget -Decision $decision
}

# --- Global hotkey (hidden message-only-ish form) ---------------------------

$hotkeyFormSource = @'
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace VoiceRouter
{
    public class HotkeyForm : Form
    {
        [DllImport("user32.dll")]
        private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

        [DllImport("user32.dll")]
        private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

        private const int WM_HOTKEY = 0x0312;
        private const int HOTKEY_ID = 1;
        private readonly uint modifiers;
        private readonly uint vk;

        public event EventHandler HotkeyPressed;
        public bool Registered { get; private set; }

        public HotkeyForm(uint mod, uint key)
        {
            modifiers = mod;
            vk = key;
            this.FormBorderStyle = FormBorderStyle.FixedToolWindow;
            this.ShowInTaskbar = false;
            this.Size = new System.Drawing.Size(0, 0);
        }

        protected override void SetVisibleCore(bool value)
        {
            base.SetVisibleCore(false);
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            Registered = RegisterHotKey(this.Handle, HOTKEY_ID, modifiers, vk);
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_HOTKEY && m.WParam.ToInt32() == HOTKEY_ID)
            {
                if (HotkeyPressed != null) HotkeyPressed(this, EventArgs.Empty);
            }
            base.WndProc(ref m);
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            UnregisterHotKey(this.Handle, HOTKEY_ID);
            base.OnFormClosing(e);
        }
    }
}
'@

Add-Type -TypeDefinition $hotkeyFormSource -ReferencedAssemblies System.Windows.Forms, System.Drawing

$modifierFlags = @{ Control = 0x0002; Alt = 0x0001; Shift = 0x0004; Win = 0x0008 }
$modFlags = 0
foreach ($modifierName in $script:Config.hotkey.modifiers) {
    $modFlags = $modFlags -bor $modifierFlags[$modifierName]
}
$vkCode = [int][Enum]::Parse([System.Windows.Forms.Keys], $script:Config.hotkey.key)

$script:HotkeyForm = New-Object VoiceRouter.HotkeyForm($modFlags, $vkCode)
$script:HotkeyForm.add_HotkeyPressed({ Invoke-HotkeyToggle })
[void]$script:HotkeyForm.Handle

if (-not $script:HotkeyForm.Registered) {
    Write-Log 'WARNING: hotkey registration failed -- it is likely already bound by another application.'
    Show-Toast -Title 'Voice Router' -Message 'Hotkey registration failed (already in use by another app).' -Level Error
} else {
    $hotkeyLabel = ($script:Config.hotkey.modifiers -join '+') + '+' + $script:Config.hotkey.key
    Write-Log "Voice Router daemon running. Hotkey: $hotkeyLabel"
    Show-Toast -Title 'Voice Router' -Message "Ready. Press $hotkeyLabel to record." -Level Info
}

[System.Windows.Forms.Application]::Run($script:HotkeyForm)

$script:TrayIcon.Visible = $false
$script:TrayIcon.Dispose()
