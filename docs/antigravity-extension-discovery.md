# Antigravity IDE Extension Discovery Architecture & Troubleshooting Guide

**Date:** 2026-09-21  
**Applies to:** Antigravity IDE 1.107.0+, Windows PowerShell 5.1, Unpacked Local Extensions

---

## 1. Executive Summary

When developing or manually installing unpacked extensions into Antigravity IDE (`%USERPROFILE%\.antigravity-ide\extensions\`), an extension may silently fail to appear in the UI (no Activity Bar icon, no commands in the Command Palette, no activation logs).

The primary failure mode on Windows is:
1. **UTF-8 Byte Order Mark (BOM: `0xEF 0xBB 0xBF`)** introduced into `package.json` by Windows PowerShell 5.1 cmdlets (`Set-Content`, `Out-File -Encoding utf8`).
2. **Crash in Shared Process Manifest Scanner**: Node/V8's `JSON.parse` strictly enforces RFC 8259, which does not allow a BOM. Parsing throws:
   ```
   SyntaxError: Unexpected token '﻿', "﻿{\r\n  "n"... is not valid JSON
       at JSON.parse (<anonymous>)
       at Th.scanExtensionManifest (sharedProcessMain.js:77:55015)
   ```
3. **Failure to Register in `extensions.json`**: Because the manifest scanner throws, Antigravity's `LocalExtensionManagementService` aborts before writing the extension to `extensions.json`.
4. **Permanent Invisibility**: Antigravity is profile-based and only scans `extensions.json` on startup or reload. Existing folders on disk are added to `knownDirectories` and never re-scanned, even after restarting the IDE.

---

## 2. Antigravity Extension Discovery Architecture

Antigravity IDE (built on VS Code 1.107) manages extensions through a dedicated Node-based process called **Shared Process** (`sharedProcessMain.js`).

### Discovery Paths

```mermaid
flowchart TD
    subgraph Antigravity Startup / Window Reload
        A[Start / Reload] --> B[scanExtensionsFromProfile]
        B --> C[Read extensions.json]
        C --> D{Entry in extensions.json?}
        D -- Yes --> E[Load Extension into Workbench & ExtHost]
        D -- No --> F[Ignore Folder Completely]
        A --> G[watchForExtensionsNotInstalledBySystem]
        G --> H[Enumerate child dirs in .antigravity-ide/extensions]
        H --> I[Add all existing folders to knownDirectories Set]
    end

    subgraph Hot Folder Watcher (Runtime Only)
        J[New Folder Added] --> K[onDidFilesChange: t.rawAdded]
        K --> L{Folder in knownDirectories?}
        L -- Yes --> M[Skip / Do Nothing]
        L -- No --> N[scanUserExtensionAtLocation]
        N --> O[scanExtensionManifest: JSON.parse]
        O -- Throws SyntaxError (BOM) --> P[Log to sharedprocess.log & Return null]
        P --> Q[Never calls addExtensionsToProfile]
        O -- Parses Cleanly --> R[addExtensionsToProfile]
        R --> S[Write to extensions.json & Fire onDidInstallExtensions]
    end
```

### Key Architectural Behaviors

1. **`extensions.json` is the Single Source of Truth for Installed Extensions**:
   - Location: `C:\Users\<user>\.antigravity-ide\extensions\extensions.json`.
   - On IDE startup or window reload, Antigravity calls `scanExtensionsFromProfile()`, which reads `extensions.json`. It does **not** walk disk subdirectories to find new unmanaged extensions.
2. **Runtime Discovery via File Watcher**:
   - `watchForExtensionsNotInstalledBySystem()` registers a watcher on the extensions directory.
   - When a folder is newly created (`rawAdded`) while the IDE is running, Antigravity calls `scanUserExtensionAtLocation()`.
   - If `package.json` parses cleanly, Antigravity calls `addExtensionsToProfile()`, which updates `extensions.json` and logs:
     `[info] Added extensions to default profile from external source ["publisher.extension-name"]`
3. **The "Known Directories" Trap**:
   - On boot, all directories already present in `extensions/` are added to an in-memory `knownDirectories` set.
   - The watcher only inspects directories in `t.rawAdded` that are **not** in `knownDirectories`.
   - Modifying files inside an existing directory (`t.rawUpdated`) does **not** trigger extension re-scanning or registration.
   - If an extension fails its initial scan (due to invalid JSON / BOM) or was copied while the IDE was closed, it will never be picked up on reload or restart unless `extensions.json` is manually updated or the folder is re-added fresh.

---

## 3. The Windows PowerShell BOM Pitfall

In Windows PowerShell 5.1 (the default built-in PowerShell on Windows 10 and 11):
- `Out-File -Encoding utf8` writes **UTF-8 with BOM** (`0xEF 0xBB 0xBF`).
- `Set-Content -Encoding utf8` writes **UTF-8 with BOM**.
- Default `Out-File` without `-Encoding` writes **UTF-16 LE with BOM** (`0xFF 0xFE`).

### Why `JSON.parse` Fails

In JavaScript / V8:
- Standard JSON grammar: `JSON-text = ws value ws`. Whitespace characters are strictly `0x20` (space), `0x09` (horizontal tab), `0x0A` (LF), and `0x0D` (CR).
- Character `\uFEFF` (Byte Order Mark) is **not** valid JSON whitespace.
- When `fs.readFile()` or Antigravity's `fileService.readFile()` decodes a UTF-8 BOM file to a string, the string begins with `\uFEFF`.
- Calling `JSON.parse("\uFEFF{...}")` throws an immediate `SyntaxError: Unexpected token '﻿'`.

---

## 4. Diagnosing a Missing Extension

If an unpacked extension does not appear in Antigravity:

### Step 1: Check Antigravity CLI Extension List
Run the CLI binary to see what Antigravity's profile engine currently recognizes:
```powershell
& "$env:LOCALAPPDATA\Programs\Antigravity IDE\bin\antigravity-ide.cmd" --list-extensions
```
If your extension is not in this list, Antigravity does not know it exists.

### Step 2: Check `sharedprocess.log`
Examine the shared process logs for `SyntaxError` or manifest scan failures:
```powershell
Get-ChildItem -LiteralPath "$env:APPDATA\Antigravity IDE\logs" -Recurse -Filter "sharedprocess.log" |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 2 |
    ForEach-Object {
        Write-Host "=== $($_.FullName) ===" -ForegroundColor Cyan
        Get-Content -LiteralPath $_.FullName | Select-String -Pattern "SyntaxError|scanExtension|Marked extension" -Context 0, 3
    }
```

### Step 3: Check for BOM in `package.json`
Verify the first bytes of the installed `package.json`:
```powershell
$path = "$env:USERPROFILE\.antigravity-ide\extensions\<folder-name>\package.json"
[System.IO.File]::ReadAllBytes($path)[0..3] | ForEach-Object { "0x{0:X2}" -f $_ }
```
- **If output is `0xEF 0xBB 0xBF 0x7B`**: UTF-8 with BOM (Broken).
- **If output is `0xFF 0xFE`**: UTF-16 LE (Broken).
- **If output is `0x7B` (`{`)**: Clean UTF-8 (Correct).

### Step 4: Check `extensions.json`
Inspect whether the extension ID is registered:
```powershell
$json = Get-Content -LiteralPath "$env:USERPROFILE\.antigravity-ide\extensions\extensions.json" -Raw | ConvertFrom-Json
$json | Where-Object { $_.identifier.id -like "*<extension-name>*" }
```

---

## 5. The Fix & Reliable Installation Methods

### Option A: Remove BOM & Register in `extensions.json` (Recommended)

Run this Node-based script to strip any BOM and cleanly register the extension in `extensions.json`:

```javascript
// fix-and-register.js
const fs = require('fs');
const path = require('path');

const extFolder = 'local.ai-chat-panel-0.1.0';
const extId = 'local.ai-chat-panel';
const extVersion = '0.1.0';

const extDir = path.join(process.env.USERPROFILE, '.antigravity-ide', 'extensions');
const pkgPath = path.join(extDir, extFolder, 'package.json');
const registryPath = path.join(extDir, 'extensions.json');

// 1. Strip BOM from package.json
let raw = fs.readFileSync(pkgPath, 'utf8');
if (raw.charCodeAt(0) === 0xFEFF) {
  raw = raw.slice(1);
  fs.writeFileSync(pkgPath, raw, 'utf8');
  console.log('Stripped BOM from package.json');
}

// 2. Register in extensions.json
const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
if (!registry.some(e => e.identifier?.id === extId)) {
  registry.push({
    identifier: { id: extId },
    version: extVersion,
    location: {
      $mid: 1,
      path: `/${extDir.replace(/\\/g, '/')}/${extFolder}`,
      scheme: 'file'
    },
    relativeLocation: extFolder
  });
  fs.writeFileSync(registryPath, JSON.stringify(registry), 'utf8');
  console.log(`Registered ${extId} in extensions.json`);
} else {
  console.log(`${extId} already registered in extensions.json`);
}
```

Then run **Developer: Reload Window** in Antigravity (`Ctrl+Shift+P`).

### Option B: Directory Junction for Local Development (Like `vscode-astro-editor`)

Creating a Windows Directory Junction directly links the source folder to the extensions folder. Any source code edits (JS, CSS, HTML) take effect immediately upon reload without needing to re-copy files:

```powershell
$extDir = Join-Path $env:USERPROFILE '.antigravity-ide\extensions'
$dest = Join-Path $extDir 'local.ai-chat-panel-0.1.0'
$src = "C:\Users\user\Nextcloud\Eigene Projekte\Portfolio\2026\tools\ai-chat-panel"

# 1. Remove existing copied folder if present
if (Test-Path -LiteralPath $dest) {
    Remove-Item -LiteralPath $dest -Recurse -Force
}

# 2. Create directory junction
New-Item -ItemType Junction -Path $dest -Target $src

# 3. Ensure extensions.json entry exists
# (See Option A above)
```

### Option C: Official VSIX Packaging

If distributing or installing cleanly without manual JSON edits:
```powershell
cd "astro-visual-editor/tools/ai-chat-panel"
npx.cmd @vscode/vsce package --no-dependencies
& "$env:LOCALAPPDATA\Programs\Antigravity IDE\bin\antigravity-ide.cmd" --install-extension local.ai-chat-panel-0.1.0.vsix
```
This invokes VS Code's official packaging and installation engine, which unpacks the extension, guarantees valid encoding, and registers `extensions.json` automatically.

---

## 6. Symptom: Webview Panel "Loading Forever" (Infinite Progress Bar)

When an extension appears in the Activity Bar with its title and view container, but the view displays a continuous pulsing progress bar and empty body:

### Root Cause
In VS Code / Antigravity architecture:
1. `contributes.viewsContainers` and `contributes.views` are registered declaratively by the workbench UI directly from `package.json`.
2. To render the inner webview content, the workbench triggers extension activation (`onView:<viewId>` or `onStartupFinished`) to locate the registered `WebviewViewProvider`.
3. If the extension's `extension.js` (or any required module) throws an uncaught error at require-time or inside `activate(context)`:
   - Extension activation **aborts**.
   - `vscode.window.registerWebviewViewProvider()` is **never called**.
   - The workbench waits indefinitely for the provider to register, resulting in a permanent loading progress bar.

### Diagnostic Command
Check the Extension Host log for uncaught activation errors:
```powershell
Get-ChildItem -LiteralPath "$env:APPDATA\Antigravity IDE\logs" -Recurse -Filter "exthost.log" |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1 |
    ForEach-Object {
        Get-Content -LiteralPath $_.FullName | Select-String -Pattern "Activating extension|Error: Cannot find module" -Context 0, 5
    }
```

### Monorepo Isolation Pitfall
The most common cause of activation failure in local extensions is **escaping relative paths**:
- In the source monorepo, `astro-visual-editor/tools/ai-chat-panel/lib/quota-bridge.js` reached into sibling tools:
  `require('../../antigravity-usage-statusbar/usage.js')`
- When installed into `~/.antigravity-ide/extensions/local.ai-chat-panel-0.1.0/`, that relative path points outside the extension directory to non-existent locations, immediately throwing `Error: Cannot find module`.
- **Rule:** Installed extensions must be strictly self-contained. Any shared code must either be bundled/copied into the extension's own directory (e.g. `lib/usage.js`) or dynamically resolved with graceful fallbacks.

