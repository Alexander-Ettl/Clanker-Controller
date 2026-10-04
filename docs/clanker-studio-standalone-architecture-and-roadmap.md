# Clanker Studio: Standalone Agentic Desktop Architecture, Industry Benchmark & Implementation Roadmap

**Document Version:** `1.0.0`  
**Date:** October 1, 2026  
**Scope:** Standalone Cross-Platform Application (Windows, macOS, Linux) independent of VS Code / IDE hosts.  
**Repository Location:** `astro-visual-editor/docs/clanker-studio-standalone-architecture-and-roadmap.md`  
**Core Lineage:** Decoupled `ClankerController` engine (`astro-visual-editor/tools/ai-chat-panel/`), multi-agent orchestration, and native OS sandboxing.

---

## 1. Executive Summary & Paradigm Inversion

### 1.1 The Shift from "Editor-First" to "Agentic-First"
Traditional IDEs (VS Code, JetBrains, Eclipse) were designed around an interaction model conceived in the 1990s: **the human is the primary typist**, manually editing character-by-character in a text buffer while linting, compilation, and autocompletion operate as auxiliary aids. Modern AI IDEs (Cursor, Copilot in VS Code) largely maintain this layout: a monolithic text editor occupying 80% of the screen, with the AI relegated to a sidebar or a floating modal composer.

```
TRADITIONAL / COPILOT IDE (Editor-First)       CLANKER STUDIO (Agentic-First)
┌───────────────────────────┬──────────────┐  ┌───────────────────────────┬──────────────┐
│                           │ AI Sidebar   │  │ AGENTIC STAGE (60%)       │ CANVAS (40%) │
│                           │ (Assistant)  │  │ • Multi-Agent Triad Plan  │ • Monaco     │
│   MONOLITHIC FILE BUFFER  ├──────────────┤  │ • Shadow Execution Stream │   Diff View  │
│   (Human writes code)     │ Prompt /     │  │ • Concentric Quota Rings  │ • Visual AST │
│                           │ Autocomplete │  │ • Tool Cards & Approvals  │ • Live Web   │
│                           │              │  │ • Test/Lint Repair Loop   │   Preview    │
├───────────────────────────┴──────────────┤  ├───────────────────────────┴──────────────┤
│ Terminal / Output Console                │  │ [FLOATING DYNAMIC ISLAND: Voice/Model/@] │
└──────────────────────────────────────────┘  └──────────────────────────────────────────┘
```

**Clanker Studio** inverts this relationship:
1. **The Autonomous Agent is the Primary Typist:** Writing code, creating file hierarchies, running test suites, resolving type errors, and managing git branches happen autonomously inside isolated, ephemeral **Shadow Workspaces** (`git worktree`).
2. **The Human is the Tech Lead / Reviewer:** The developer guides high-level intent via multimodal inputs (technical voice dictation, slash commands, `@` context mentions), inspects structural diffs, and grants push approvals.
3. **ClankerController's Existing Moat Becomes the Core:** Rather than functioning as an extension constrained by VS Code's single-threaded extension host and webview sandbox, Clanker's existing capabilities—**predictive 5h/7d quota intelligence**, **autonomous scheduler watchdogs**, **multi-agent auto-routing with contract locks**, **bidirectional Telegram mobile cockpits**, and **self-learning voice dictation**—become the application's native foundation.

---

## 2. Industry Benchmark: How Frontier AI Labs Build Desktop Apps

To engineer a best-in-class standalone architecture, we benchmark against the exact specifications, tech stacks, IPC protocols, and sandboxing systems used by OpenAI, Anthropic, Google, and performance outliers like Zed across Windows, macOS, and Linux.

### 2.1 Cross-Platform Industry Stack Matrix

| Company / Product | Desktop Shell | Core Engine / Backend | IPC Protocol | Sandboxing / Isolation | Terminal / PTY |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **OpenAI Codex** (`app-server` / App) | **macOS:** Native Swift/AppKit<br>**Windows:** Electron / WebView2 | **Rust** (`codex-rs/app-server`) | Bidirectional **JSON-RPC 2.0** over `stdio` / WebSockets | **macOS:** `sandbox-exec`<br>**Linux:** Landlock LSM / seccomp<br>**Windows:** Job Objects + Tokens | `portable-pty` (Rust) |
| **Anthropic Claude Code** | Custom TUI (Node.js + pure-TS Yoga flexbox) | **TypeScript / Node.js** | Stream-JSON (`ndjson`) & `--permission-prompt-tool stdio` | Subprocess privilege separation, path boundary checks, worktree isolation | `node-pty` / Posix PTY |
| **Anthropic Claude Desktop** | **Electron** + React | Local Node daemon | Model Context Protocol (**MCP**) via `stdio` | Chromium renderer isolation + OS sandbox | None (Chat/MCP only) |
| **Google Antigravity IDE** | Forked Code-OSS (Electron) | Local **Go** Language Server sidecar | **Connect-RPC** (Protobufs over local HTTP/2) | Ephemeral "Shadow Workspaces", OAuth session tokens | Custom VS Code ConPTY bridge |
| **Zed** | **GPUI** (Custom 100% Rust GPU framework) | **Rust** (Async Rust, Tokio) | Internal Rust channels + LSP | Native thread isolation | Native Rust PTY (`alacritty_terminal`) |
| **Cursor / Windsurf** | Forked Code-OSS (Electron) | **Rust / C++** native node addons | Shared memory / IPC pipes + LSP multiplexing | Electron sandbox + shadow git branches | ConPTY (Win) / openpty (Unix) |

---

### 2.2 Deep Architectural Teardowns

#### 1. OpenAI: Decoupled Codex App Server (`codex-rs`)
OpenAI separates the agent execution harness completely from all client UIs:
- **The Harness:** Written in **Rust** (`openai/codex`), the `codex-rs` app-server compiles to a single, static binary with zero runtime dependencies.
- **Protocol Primitives:** Unlike generic HTTP REST, the Codex App Server protocol defines three durable primitives:
  - `Thread`: A persistent session container saved on disk; can be paused, resumed, or forked across machine reboots.
  - `Turn`: An atomic unit of user instruction consisting of planning, tool calls, and completion.
  - `Item`: Fine-grained streaming components (`item/commandExecution`, `item/fileChange`, `item/tool/requestUserInput`, `item/approvalRequest`).
- **Bidirectional Control Flow:** When Codex wants to run a destructive bash command, the server initiates an RPC call *to the client* (`requestApproval`). The agent blocks asynchronously until the client responds over stdio.
- **Multi-Client Support:** This single Rust daemon powers the macOS Swift app, the Windows Electron shell, the CLI tool, and external IDE extensions.

#### 2. Anthropic: Claude Code & Terminal Yoga Engine
Anthropic avoided heavy webviews for their primary coding agent:
- **Custom Terminal UI Engine:** Rather than using off-the-shelf `ink`, Anthropic engineered a custom terminal rendering engine using a pure TypeScript port of Meta's **Yoga** flexbox layout engine. This gives terminal windows CSS-like flexbox responsiveness, mouse support, and OSC-8 hyperlink clicks.
- **Tree-sitter Verification:** Integrates Tree-sitter AST parsing directly into the pre-execution loop. Before bash commands or edits execute, Tree-sitter verifies that syntax remains valid and tools do not escape declared boundaries.
- **Git Worktree Isolation:** Spawns subagents in isolated `git worktree` instances, allowing parallel research without dirtying the developer's working directory.

#### 3. Google: Antigravity IDE & Connect-RPC Sidecar
Google adopted an out-of-process sidecar architecture:
- **Connect-RPC Control Plane:** The Antigravity IDE runs a background Language Server daemon in **Go**. The IDE frontend communicates with this daemon using **Connect-RPC** (a modern, lightweight alternative to gRPC that works over standard HTTP/1.1 and HTTP/2 with JSON or Protocol Buffers).
- **Decoupled Extensions:** Tools like mobile companions, CLI monitors (`agy`), and statusbars query the local Language Server port using standard HTTP POST requests with a local CSRF bearer token.
- **Shadow Workspaces:** The Language Server automatically mirrors the workspace into a detached git shadow tree, tests generated patches with background compilers, and surfaces only verified diffs to the UI.

#### 4. Zed: The Extreme-Performance Benchmark (Rust + GPUI)
Zed proves that developer productivity skyrockets when input latency drops below 16ms:
- **GPUI Rendering:** Zed renders its entire UI via the GPU using Metal (macOS) and Vulkan/DirectX (Linux/Windows). Memory consumption is ~150MB (versus 800MB–1.5GB for Electron).
- **Parallel Agent Engine:** Zed's Assistant Panel runs multi-threaded agent loops directly in Tokio tasks, indexing codebases with Tree-sitter AST queries in milliseconds.

---

## 3. Technology Stack Selection: The 2026 AI-Era Reality Check

When designing a standalone desktop app today, the traditional trade-offs look very different than they did in the "pre-AI" era.

### 3.1 Does AI Invalidate the "Node First" Recommendation?
In 2026, AI coding agents write backend Rust with remarkable speed. Rust's strict compiler (`rustc`) acts as an automated verification loop: an LLM can parse compiler errors, fix lifetimes and type mismatches autonomously, and deliver memory-safe code without human intervention.

**So why not build 100% native Rust immediately?**  
The bottleneck is not the language syntax—**it is the desktop rendering engine, the UI architecture, and the battle-tested code you already own.**

---

### 3.2 The Three Critical Obstacles

#### 1. The Monaco Editor & Liquid Glass Trap
Clanker Studio requires two visual surfaces:
- **The Code & Diff Canvas:** You want an interactive, syntax-highlighted diff and code inspection canvas. That means Microsoft's **Monaco Editor** (the core editor component of VS Code). Monaco is written in TypeScript and **only runs inside a web browser engine (Blink/WebKit)**.
- **The Liquid Glass UI:** Clanker's visual signature relies on SVG filters (`feGaussianBlur`, `feColorMatrix` for the goo effect), mathematical superellipse squircles, Shiki syntax highlighting, and KaTeX math.

If you build **100% native Rust (like Zed with GPUI or Slint/egui)**:
- Monaco Editor does not exist. You would have to build or adopt a raw GPU text buffer from scratch.
- HTML/CSS and SVG filters do not exist. You cannot reuse existing CSS, Dynamic Island docks, or SVG goo filters. You would have to write custom Metal/DirectX/Vulkan GPU fragment shaders for every frosted glass panel, liquid neck, and squircle.

#### 2. The "Multi-Browser Inconsistency Tax" in Tauri 2.0
If you choose **Tauri 2.0** (Rust backend + Web frontend using system webviews):
- **Windows** runs **WebView2** (Chromium-based).
- **macOS** runs **WKWebView** (Apple Safari / WebKit).
- **Linux** runs **WebKitGTK**.

Safari's WebKit and Google's Chromium do **not** render advanced CSS, backdrop-filter blurs, and SVG filters identically. Apple's WebKit has notoriously strict security policies around local WebSockets, different subpixel font antialiasing, and quirkier SVG composite blending. Even with AI generating code, you as the developer must visually test and debug layout drift between operating systems.  
In **Electron**, the renderer is Chromium on *every* OS—zero visual drift.

#### 3. The 80-Hour Code Asset You Already Own
The core business logic in `astro-visual-editor/tools/ai-chat-panel/lib/` is already written, debugged, and battle-tested in Node.js:
- Streaming NDJSON parsers with transient 503 backoff retries (`lib/stream-engine.js`)
- Codex App Server persistent stdio JSON-RPC thread handling (`lib/codex-app-server.js`)
- Quota rollover math, disk cache, and zero-token probing (`lib/quota-bridge.js`)
- DirectShow audio streaming via FFmpeg + Groq Whisper (`lib/voice-capture.js`)
- Telegram bot webhooks + automated Cloudflare tunnels (`lib/telegram-bridge.js`)

Rewriting working process-orchestration code into Rust doesn't give users any new features today—it just gives them a smaller binary size at the cost of weeks of debugging subprocess and terminal edge cases.

---

### 3.3 Runtime Comparison Matrix

| Dimension | Option A: Electron + Node Core | Option B: Tauri 2.0 + Rust Core | Option C: Pure Rust GPUI (Zed-style) |
| :--- | :--- | :--- | :--- |
| **Time to Working App** | **3 to 5 days** (reusing existing code) | **2 to 3 weeks** (translating + glue) | **3 to 6 months** (custom shaders/editor) |
| **UI Polish & Consistency** | **Identical** across all platforms | Requires WebKit (Mac) vs Blink (Win) fixes | Requires custom GPU fragment shaders |
| **Memory Footprint** | 350MB – 600MB RAM | 60MB – 120MB RAM | 50MB – 100MB RAM |
| **Installer Size** | ~120MB | ~18MB | ~15MB |
| **Monaco Diff Canvas** | Native integration (1-2 days) | Supported via WebView | Not supported (custom buffer required) |
| **Feel / Craftsmanship** | Standard modern web-desktop app | High-performance, lightweight tool | Ultra-responsive 120fps native tool |

---

## 4. System Architecture of Standalone Clanker Studio

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         CLANKER STUDIO ARCHITECTURE                         │
├─────────────────────────────────────────────────────────────────────────────┤
│  PRESENTATION TIER (Tauri 2.0 or Electron + React 19 + Liquid Glass)        │
│  ├── Dynamic Island Dock (Microphone, Model Pill, Slash commands, Queue)    │
│  ├── Concentric 5h/7d Quota Gauges (Real-time SVG arc updates)             │
│  ├── Multi-Agent Orchestration Stream (Tool cards, Thinking, Plan DAGs)     │
│  ├── Dual-Pane Canvas: Embedded Monaco Diff Editor + Astro Visual Preview  │
│  └── Hunk-by-Hunk Patch Staging & Interactive Discard/Accept               │
├─────────────────────────────────────────────────────────────────────────────┤
│  IPC & PROTOCOL BUS (Local JSON-RPC 2.0 / WebSocket / Connect-RPC)         │
├─────────────────────────────────────────────────────────────────────────────┤
│  CLANKER CORE DAEMON (Headless Background Service)                          │
│  ├── Agent Triad Adapters                                                   │
│  │   ├── Claude Code Bridge (stream-json + --permission-prompt-tool)        │
│  │   ├── Codex App-Server Bridge (Persistent stdio JSON-RPC)                │
│  │   ├── Google Antigravity Bridge (agy stream-json + Connect-RPC)          │
│  │   └── Universal Model Hub (Direct OpenRouter, Ollama, DeepSeek APIs)     │
│  ├── Orchestration & Dispatch Engine                                       │
│  │   ├── Auto-Router with Quota Fallback & Contract Locks                   │
│  │   ├── Quota Telemetry Bridge (Concentric 5h/7d sliding windows)          │
│  │   ├── Rollover Self-Healing & Disk-Persisted Resets Cache                │
│  │   └── Autonomous Quota-Gated Scheduler Watchdog                          │
│  ├── Agentic Workspace Engine (The "Shadow Engine")                        │
│  │   ├── Ephemeral Git Worktree Manager (`.clanker/worktrees/`)             │
│  │   ├── Automated "Make it Green" Test/Lint Self-Correction Loop           │
│  │   ├── Turn Checkpointer & Instant Rollback (`/undo`)                     │
│  │   └── Tree-sitter Structural AST Codebase Index (Repo Map)               │
│  ├── Hardware & Remote Sensors                                              │
│  │   ├── DirectShow / CoreAudio / PipeWire Voice Pipeline                   │
│  │   ├── Real-Time Speech Level Visualizer & Groq Whisper Transcriber       │
│  │   ├── Adaptive Jargon Learner (LCS diff & bigram Dice similarity)        │
│  │   ├── Telegram Remote Cockpit (Push Approvals, Bot Controller)           │
│  │   └── Cloudflare Tunnel Manager (Zero-config external URL)               │
│  └── Cross-Platform Sandbox Manager                                         │
│      ├── Windows: Job Objects + Restricted Token + PowerShell Sandbox       │
│      ├── macOS: `sandbox-exec` profiles (Seatbelt)                          │
│      └── Linux: Landlock LSM + unshare namespaces                           │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Translating ClankerController's Existing Moat to Standalone Primitives

Every subsystem already built in `astro-visual-editor/tools/ai-chat-panel/` maps cleanly into the standalone application:

### 5.1 Quota Intelligence & Concentric Telemetry
- **Current State (`lib/quota-bridge.js`, `lib/quota-sources.js`):** Injects telemetry into VS Code statusbars; runs zero-token background probes for Claude and Codex.
- **Standalone Evolution:** The standalone daemon hosts a persistent SQLite or JSON disk cache (`~/.clanker/quota-state.json`). It continuously monitors 5-hour and 7-day windows across Claude, Codex, and Gemini.
- **System Tray & Menu Bar:** In addition to in-app gauges, Clanker Studio renders a native macOS menu bar / Windows system tray icon displaying live concentric arcs with hover countdowns.

### 5.2 Multi-Agent Auto-Router & Contract Lock
- **Current State (`lib/auto-router.js`):** Directs UI/CSS to Claude, backend AST/IPC to Codex, architecture/docs to Gemini; enforces contract locks.
- **Standalone Evolution:** In an agentic-first workflow, the router orchestrates multi-agent **DAG (Directed Acyclic Graph)** execution:
  1. *Gemini 3.8 Flash High* synthesizes the formal specification and API contract.
  2. *Codex* implements backend schemas, database migrations, and IPC handlers in a shadow branch.
  3. *Claude* implements the visual UI components against the contract.
  4. The router verifies that both branches adhere to the contract before merging.

### 5.3 Quota-Gated Scheduler Watchdog & Limit-Reset Resumption
- **Current State (`lib/scheduler-queue.js`):** Schedules delayed tasks; holds execution until reset timestamps pass.
- **Standalone Evolution:** Because Clanker Studio can run as a background daemon, the developer can queue 10 heavy refactoring tasks and close the laptop or UI. The daemon stays alive, waits for Claude's 5-hour window or Codex's weekly limit to reset at 03:00 AM, wakes up, executes the turns, runs the test suite, and pushes a summary to Telegram.

### 5.4 Telegram Remote Cockpit & Cloudflare Tunnel
- **Current State (`lib/telegram-bridge.js`, `lib/telegram-control.js`):** Sends push cards with `[Allow]` / `[Deny]` for tool execution; serves a web mini app over `cloudflared`.
- **Standalone Evolution:** Operates completely decoupled from VS Code. Whether the developer is commuting or at dinner, when an agent in Clanker Studio needs confirmation to delete a file or execute a bash script, an interactive Telegram card arrives instantly. Tapping `[Allow]` unblocks the local execution loop on the workstation.

### 5.5 Technical Voice Dictation & Self-Learning Engine
- **Current State (`lib/voice-capture.js`, `lib/voice-learn.js`):** DirectShow audio capture via FFmpeg; computes PCM RMS every 40ms; transcribes via Groq Whisper; extracts custom jargon via LCS.
- **Standalone Evolution:**
  - **Cross-Platform Audio:** Uses native OS audio capture (`DirectShow` on Windows, `AVFoundation` / `CoreAudio` on macOS, `PulseAudio` / `PipeWire` on Linux).
  - **Global Push-to-Talk Hotkey:** A system-wide shortcut (`Ctrl+Space` or `Caps Lock hold`) opens the Clanker Studio Dynamic Island from anywhere in the OS, streams live audio waveforms, transcribes intent, and directs it to the active project without switching windows.

---

## 6. The Shift to an Agentic-First Workflow (New Primitives)

To surpass VS Code and achieve the autonomy of tools like Aider, Claude Code, and Codex, Clanker Studio introduces four core agentic primitives:

### 6.1 Ephemeral Shadow Workspaces (`git worktree`)
Instead of allowing agents to edit files directly in the user's active working tree (which causes editor flickering, broken compilation, and loss of uncommitted work):
1. When a task starts, Clanker Studio creates an isolated git worktree:
   ```bash
   git worktree add -B clanker/shadow-<id> .clanker/shadows/<id> HEAD
   ```
2. The agent executes all bash commands, file modifications, and installations inside this isolated directory.
3. The developer's main editor and uncommitted files remain 100% untouched while the agent works.

### 6.2 The Automated "Make it Green" Test/Lint Repair Loop
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    "MAKE IT GREEN" SELF-CORRECTION LOOP                     │
└─────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
                   Agent Generates Code Modifications
                                  │
                                  ▼
             Runs Configured Test / Lint Command in Shadow
                     (e.g., `npm test`, `pytest`)
                                  │
                 ┌────────────────┴────────────────┐
                 │                                 │
              [PASSED]                          [FAILED]
                 │                                 │
                 ▼                                 ▼
       Present Clean Diff               Capture Stderr / Callstack
         to Developer                              │
                                                   ▼
                                        Feed Error back to Model
                                        (Max 3 Autonomous Tries)
                                                   │
                                                   ▼
                                          Iterate & Patch Code
```
If tests fail, Clanker does not stop to ask the user. It extracts the stack trace, identifies the offending lines, generates a surgical fix, and re-tests. Only once the test suite is green does it present the finished diff to the user.

### 6.3 Tree-sitter Structural AST Codebase Map
Feeding full files into an LLM exhausts context and wastes money. Clanker Studio embeds **Tree-sitter** parsers for JavaScript, TypeScript, Python, Go, Rust, and CSS:
- Parses the entire project structure in <200ms.
- Extracts classes, methods, exported types, function signatures, and imports.
- Compresses the codebase into a dense **~1,200-token structural index** injected into the system prompt.
- The agent knows the exact signature of every symbol across the entire repo without reading the files.

### 6.4 Interactive Hunk-by-Hunk Diff Inspector
Rather than an all-or-nothing file save, Clanker Studio's code canvas provides a tactile Liquid Glass diff viewer:
- Each modified file is presented with collapsible hunk cards.
- Each hunk has micro-controls: `[Accept Hunk]`, `[Reject Hunk]`, `[Ask AI to Rephrase]`.
- Developers can partially stage changes directly to git with zero terminal commands.

---

## 7. OS Specifications & Sandboxing Matrix (Win / Mac / Linux)

Running arbitrary bash commands generated by autonomous agents requires OS-level sandboxing:

### 7.1 Windows
- **Terminal Host:** Windows **ConPTY** via `node-pty` or Rust `portable-pty`.
- **Sandboxing:**
  - Launch child processes inside a **Windows Job Object** with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` to prevent orphaned background processes.
  - Apply restricted access tokens (similar to Codex's `workspaceWrite` sandbox), restricting file write operations to the active workspace folder and temporary scratch directories.
- **Audio Capture:** DirectShow audio input device enumeration via FFmpeg.

### 7.2 macOS
- **Terminal Host:** POSIX `openpty`.
- **Sandboxing:**
  - Use Apple's **Seatbelt** sandbox via `sandbox-exec` with tailored `.sb` profiles limiting filesystem access exclusively to the target workspace directory and blocking outgoing network calls for untrusted commands.
- **Audio Capture:** CoreAudio / AVFoundation native device streaming with explicit microphone entitlements (`com.apple.security.device.audio-input`).

### 7.3 Linux
- **Terminal Host:** POSIX `openpty`.
- **Sandboxing:**
  - Use modern **Landlock LSM** (Linux 5.13+) and **seccomp-bpf** filters to enforce filesystem sandboxing without requiring root or Docker overhead.
  - Optional fallback to `bubblewrap` (bwrap) for lightweight namespace isolation.
- **Audio Capture:** ALSA, PulseAudio, or PipeWire audio streams.

---

## 8. Development Timeline & Effort Estimates

Based on the **80 hours of full-time effort** already invested in Clanker Controller:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          DEVELOPMENT TIME ESTIMATES                         │
├─────────────────────────────┬───────────────────┬───────────────────────────┤
│ Path                        │ Total Dev Hours   │ Calendar Timeline         │
├─────────────────────────────┼───────────────────┼───────────────────────────┤
│ Path 1: Fast-Track MVP      │ ~90 – 120 hours   │ 2.5 – 3 weeks full-time   │
│ (Electron + Reused Core)    │                   │ (or 6 – 8 weeks part-time)│
├─────────────────────────────┼───────────────────┼───────────────────────────┤
│ Path 2: Production Craft    │ ~240 – 320 hours  │ 6 – 8 weeks full-time     │
│ (Tauri 2.0 + Rust Engine)   │                   │ (or 4 – 5 months part-time│
└─────────────────────────────┴───────────────────┴───────────────────────────┘
```

### Granular Work Packages (Path 1: The Fast-Track Route)

| Milestone | Scope & Deliverables | Est. Hours |
| :--- | :--- | :---: |
| **1. Daemon Decoupling** | Strip `vscode.*` calls from `lib/`, create a standalone Node CLI daemon exposing a local JSON-RPC / WebSocket server over stdio / localhost. | **15 – 20 h** |
| **2. Desktop Shell & Windowing** | Scaffold Electron app, frameless window with native controls, system tray icon with concentric quota rings, global push-to-talk hotkey (`Ctrl+Space`). | **18 – 24 h** |
| **3. Liquid Glass UI Migration** | Port existing webview CSS, Dynamic Island docks, SVG goo filter (`#msg-goo`), Shiki code highlighting, and KaTeX into the Electron renderer window. | **10 – 15 h** |
| **4. The Code Canvas (Monaco)** | Embed Microsoft's Monaco Diff Editor into a split-pane canvas to render file changes, diff cards, and inline hunk acceptance. | **16 – 22 h** |
| **5. Shadow Workspaces & Git** | Implement automated `git worktree` isolation (`.clanker/shadows/`) and turn-level snapshot checkpoints with instant `/undo`. | **15 – 20 h** |
| **6. "Make it Green" Auto-Repair** | Background test/lint execution runner (captures stderr from `npm test`/`pytest`, feeds errors back to the model for up to 3 repair iterations). | **12 – 16 h** |
| **7. Cross-Platform Packaging** | Build scripts for Windows (`.exe` via electron-builder), macOS universal (`.dmg`), and Linux (`.AppImage`), basic code signing setup. | **15 – 20 h** |
| **TOTAL** | **Fully working, standalone daily driver** | **~100 – 135 h** |

---

### Where the "Hidden 40%" of Time Lurks

1. **Cross-Platform Audio Permissions (macOS TCC vs Windows DirectShow):**
   - Windows DirectShow works out of the box. macOS requires signed microphone entitlements (`com.apple.security.device.audio-input`), or audio drops silently. *(~8–12 hours)*
2. **OS Code Signing & Notarization:**
   - Windows SmartScreen triggers "Unknown Publisher" warnings without an EV or Azure code signing certificate.
   - macOS Gatekeeper refuses unsigned binaries; requires Apple Developer ID ($99/year) and automated `notarytool` CI integration. *(~10–15 hours)*
3. **Terminal PTY Quirks Across OSes:**
   - Windows ConPTY vs Unix openpty color sequences, backspace handling, and resize signals. *(~10–14 hours)*

---

## 9. Actionable Phased Implementation Plan

When ready to begin building Clanker Studio, follow these sequential phases:

```
PHASE 1: Core Daemon Extraction (Decouple from VS Code)
├── Extract lib/ into standalone package (@clanker/core)
├── Wrap stream-engine, auto-router, quota-bridge in JSON-RPC server
└── Implement stdio & local WebSocket transports

PHASE 2: Desktop Shell & Liquid Glass Canvas (Electron or Tauri 2.0)
├── Scaffold desktop app with React 19 + Tailwind CSS
├── Port Liquid Glass UI, Dynamic Island, and SVG goo filters
├── Integrate Monaco Editor for split-pane diff viewing
└── Bind native audio pipeline (DirectShow / CoreAudio) to waveform

PHASE 3: Shadow Engine & Agentic Self-Correction Loop
├── Build Ephemeral Git Worktree Manager
├── Implement Turn Checkpointer with instant /undo rollback
├── Build "Make it Green" test/lint execution watchdog
└── Create interactive hunk-by-hunk diff staging canvas

PHASE 4: Codebase Intelligence & Native MCP Hub
├── Embed Tree-sitter AST parser for instant repo mapping
├── Build Native MCP Client (Model Context Protocol) registry
└── Implement composer '@' autocomplete (@file, @symbol, @git)

PHASE 5: Cross-Platform Hardening & Packaging
├── Windows: ConPTY + Job Object sandbox + NSIS installer
├── macOS: Apple Silicon / Intel universal binary + Notarization
└── Linux: AppImage / Flatpak / Debian packages + Landlock sandbox
```

---

## 10. Summary & Strategic Recommendation

- **If the goal is rapid iteration and getting a standalone daily driver running:** Choose **Path 1 (Electron + Decoupled Node Daemon)**. You leverage your existing 80 hours of battle-tested code directly, avoid WebKit/Chromium visual discrepancies, embed Monaco natively in two days, and have a working app within ~100–120 hours.
- **If the goal is an uncompromising, ultra-lean native tool (Zed/Ghostty style):** Choose **Path 2 (Tauri 2.0 + Rust Engine)**. Accept the platform-glue debugging overhead and the 240–320 hour timeline in exchange for a 20MB installer and sub-100MB RAM consumption.
- **The Ideal Bridge:** Decouple the backend daemon first (`clanker-core`). Because a decoupled daemon speaks standard JSON-RPC 2.0 over stdio/WebSocket, you can start with an Electron frontend on day one, and later swap the shell to Tauri 2.0 without rewriting the core agent engine.
