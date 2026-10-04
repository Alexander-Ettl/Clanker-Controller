# Clanker Controller: Architectural Deep Dive, Competitive CLI Landscape & Prioritized Feature Gap Analysis

**Document Version:** `1.0.0`  
**Date:** September 30, 2026  
**Scope:** `astro-visual-editor/tools/ai-chat-panel/` (Clanker Controller), `vscode-extension/`, external CLI agent frameworks (Claude Code, OpenAI Codex, OpenRouter, Aider, Cline/Roo Code, Goose, OpenHands).  
**Repository Boundary:** Nested Editor Repository (`astro-visual-editor/docs/`). Private and internal until release.

---

## 1. Executive Summary

**Clanker Controller** (`ai-chat-panel`) is a unified, multi-model agentic controller and orchestration environment built inside VS Code and Google Antigravity IDE. It bridges desktop developer ergonomics, interactive PTY sessions, headless background agent streams, quota-aware dispatching, and mobile remote control into a single cohesive system.

Unlike single-vendor CLI wrappers or simple webview chat panels, Clanker acts as an **agent meta-controller**. It wraps and harmonizes three distinct AI agent CLI ecosystems:
1. **Anthropic Claude Code** (`claude` CLI)
2. **OpenAI Codex** (`codex` CLI and `codex app-server` JSON-RPC)
3. **Google Antigravity / Gemini** (`agy` CLI with Connect-RPC LanguageServer bindings)

While Clanker boasts standout features that surpass industry leaders—such as **predictive quota scheduling**, **dual-window 5h/7d concentric telemetry**, **bidirectional Telegram remote cockpits with mobile approval cards**, **zero-token usage probing**, and **self-learning technical voice dictation**—it currently lacks several critical workflow capabilities present in competitive tools like **Claude Code**, **Aider**, **Cline (Roo Code)**, and **OpenRouter-powered runners**.

This document presents:
1. An exhaustive audit of all capabilities currently implemented in Clanker Controller.
2. A comprehensive analysis of closed-source and open-source CLI agent wrappers in the modern AI ecosystem.
3. A head-to-head architectural capability matrix.
4. A prioritized, user-impact-ranked catalog of features missing from Clanker Controller, complete with technical blueprints for implementation.

---

## 2. In-Depth Investigation of Clanker Controller's Existing Capabilities

Clanker Controller's codebase (`astro-visual-editor/tools/ai-chat-panel/`) reveals an advanced, deeply thought-out architecture designed around resilience, low token overhead, and native Windows/IDE desktop integration.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           CLANKER CONTROLLER ARCHITECTURE                   │
├─────────────────────────────────────────────────────────────────────────────┤
│  FRONTEND (Liquid Glass Webview)                                            │
│  ├── Dynamic Island Composer (Audio level meter, Model pill, Attachments)  │
│  ├── Concentric Quota Gauges (5h outer, 7d inner ring with hover pills)     │
│  ├── Fullscreen Modal Sheets (Scheduled Prompts Queue, Session History)    │
│  ├── Shiki Code Highlighting + KaTeX LaTeX Math Engine                      │
│  └── Live Tool Cards (Bash execution, Capped unified diffs, Thinking tabs)  │
├─────────────────────────────────────────────────────────────────────────────┤
│  EXTENSION HOST & PROTOCOL ADAPTERS                                         │
│  ├── StreamEngine (NDJSON stream parser, Transient 503 backoff retries)     │
│  ├── Codex App Server (Persistent stdio JSON-RPC, Threads, Turns, Sandboxes)│
│  ├── Claude Bridge (--permission-prompt-tool stdio, /usage probe, Remote)   │
│  └── Antigravity Bridge (agy stream-json runner, Connect-RPC slash commands)│
├─────────────────────────────────────────────────────────────────────────────┤
│  ORCHESTRATION & TELEMETRY                                                  │
│  ├── Auto-Router (Semantic keyword dispatch, Quota fallback, Contract lock) │
│  ├── Context Compactor & Cross-Agent Handoffs (Token tracking, Checkpoints) │
│  ├── Quota Bridge & Disk Cache (Rollover detection, Zero-token /usage probe)│
│  └── Scheduler Watchdog (Quota-gated delayed runs, Limit-reset resumption)  │
├─────────────────────────────────────────────────────────────────────────────┤
│  EXTERNAL BRIDGES & SENSORS                                                 │
│  ├── Telegram Bridge (Webhook HTTP, Mobile Cockpit Mini App, Inline cards)  │
│  ├── Cloudflare Tunnel Manager (Automated cloudflared tunnel + DNS check)   │
│  ├── DirectShow Voice Capture (FFmpeg PCM levels, Groq Whisper)            │
│  ├── Voice Learner (LCS token diffs, Dice similarity jargon extraction)     │
│  └── AI Bridge v1 (Decoupled VS Code commands to Astro Visual Editor)       │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 Multi-Agent CLI Wrapping & Protocol Integration
Clanker Controller does not use vendor cloud REST APIs directly for core turns; instead, it executes and wraps local agent CLI binaries natively on the workstation (`lib/stream-engine.js`):

1. **Anthropic Claude Code (`claude` CLI):**
   - **Stream Execution:** Spawns `claude -p --input-format stream-json --output-format stream-json --verbose`.
   - **Human-in-the-Loop Interactivity:** Invokes `--permission-prompt-tool stdio` with `--permission-mode manual` or `auto`. Stdin remains open, streaming `control_request` (tool permissions and `AskUserQuestion`) and consuming `control_response` (Allow/Deny/Always Allow) without terminal lockup.
   - **Live Remote Control Bridge:** Manages `/remote-control` mode, maintaining an open headless Claude process while synchronizing state bidirectionally between the IDE panel and the official Claude mobile app.
   - **Zero-Token Quota Probing:** Periodically runs lightweight, zero-token `claude -p /usage` probes in the background to capture fresh rate-limit telemetry without consuming API tokens (`lib/claude-usage.js`).

2. **OpenAI Codex (`codex` CLI & Codex App Server):**
   - **Persistent JSON-RPC App Server (`lib/codex-app-server.js`):** Launches `codex app-server` over stdio, maintaining long-lived thread lifecycles (`thread/start`, `thread/resume`, `turn/start`).
   - **Execution Sandboxing:** Supports dynamic sandbox policies (`dangerFullAccess` vs `workspaceWrite` with restricted writable roots).
   - **Approval & Question Elicitation:** Captures JSON-RPC notifications for `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `mcpServer/elicitation/request`, and `item/tool/requestUserInput`.
   - **Native Command Execution:** Maps composer slash actions directly to App Server RPC methods (`/review`, `/compact`, `/goal`, `/status`, `/model`, `/skills`, `/mcp`, `/hooks`, `/plugins`, `/apps`, `/permissions`, `/experimental`, `/usage`).

3. **Google Antigravity / Gemini (`agy` CLI):**
   - **Headless Stream-JSON Execution:** Spawns `agy --input-format stream-json --output-format stream-json --model gemini-3.8-flash-high --add-dir <workspace>`.
   - **Multi-Turn Resumption:** Uses `--conversation <id>` for session continuity.
   - **Connect-RPC Language Server Discovery:** Directly queries the local Gemini Language Server via Connect-RPC (`fetchAntigravitySlashCommands`) to discover real-time skills and commands (`lib/antigravity.js`).

### 2.2 Quota Intelligence, Window Rollovers & Disk Persistence
One of Clanker Controller's most sophisticated subsystems is its **Quota Engine** (`lib/quota-bridge.js`, `lib/quota-sources.js`):
- **Concentric Window Tracking:** Reads both the primary short-term sliding window (5-hour) and the long-term sliding window (7-day) across Claude, Codex, and Gemini.
- **Rollover Self-Healing & Disk Cache:** Provider usage files often fail to update after an account hits 0% until the CLI runs again. Clanker caches reset timestamps (`resetsAt`) to disk (`ai-chat-panel-quota-resets.json`). When the reset timestamp passes, Clanker automatically treats the quota as replenished (100%), preventing scheduled queues from stalling indefinitely.
- **Adaptive Probing:** When Claude's readings are older than 15 minutes or a window rollover has elapsed, Clanker dispatches a zero-token `/usage` probe in the background to acquire verified telemetry.

### 2.3 Intelligent Auto-Router & Contract Lock
Clanker provides an **Auto-Routing Engine** (`lib/auto-router.js`) that dynamically selects the optimal agent based on semantic task analysis and live quota availability:
- **Domain Specialization Directives:**
  - *Claude:* Specializes in presentation, UI layout, Astro components, CSS, and kinetic animations.
  - *Codex:* Specializes in backend AST parsers, TypeScript logic, compiler schemas, and IPC channels.
  - *Gemini:* Specializes in system architecture, specifications, documentation, and long-range roadmap planning.
- **Quota-Aware Redirection:** If Claude or Codex falls below 15% quota remaining, Auto mode seamlessly redirects tasks to Gemini to conserve scarce developer capacity.
- **Immutable Contract Locks:** When a task touches both UI and backend concerns, the router automatically injects a `CONTRACT LOCK` directive, instructing the agent to preserve all existing IPC payload schemas and agree on the interface contract before implementing code.

### 2.4 Multi-Agent Memory & Compaction Handoffs
When multiple agents collaborate in a single chat thread, Clanker ensures continuity without context explosion (`lib/chat-handoff.js`):
- **Cross-Agent Handoff Briefings (`buildHandoff`):** When switching from Claude to Codex or Gemini, Clanker compiles a high-density Markdown summary of preceding turns (user prompts, clipped assistant answers, and touched file paths), stripping noisy raw tool output.
- **Context Compaction Archivist:** When token usage reaches 90% of a model's context ceiling (`AUTO_COMPACT_RATIO = 0.90`), Clanker triggers an archival compaction pass (`COMPACT_DIRECTIVE`) targeting 12,000 tokens of dense architectural summary, allowing infinite session lifespans.

### 2.5 Quota-Gated Scheduler Watchdog & Limit-Reset Resumption
Clanker Controller features an autonomous task scheduler (`lib/scheduler-queue.js`, `extension.js`):
- **Delayed & Fixed-Time Dispatch:** Supports queued tasks set to execute at a specific timestamp or when capacity becomes available.
- **Quota-Gated Watchdog:** Checks live quota levels before dispatching. If the chosen model is below 20% quota, the watchdog holds the task in `pending` state until the reset timestamp passes.
- **Auto-Continue upon Limit Reset:** If an interactive turn is cut short by a rate-limit error, the task can be queued with "Continue when limit resets". When the quota resets, Clanker automatically wakes up and resumes execution directly inside the originating chat thread.

### 2.6 Bidirectional Telegram Remote Cockpit & Cloudflare Tunnel
Clanker includes a fully featured remote control system (`lib/telegram-bridge.js`, `lib/telegram-control.js`):
- **Interactive Inline Push Approvals:** When an agent prompts for permission (Bash command execution, file modifications), Clanker sends an instant push alert to the developer's phone via Telegram with inline buttons (`[Allow]`, `[Always Allow]`, `[Deny]`).
- **Interactive Question Handling:** Agent inquiries (`AskUserQuestion`) are forwarded to Telegram with selectable choice buttons or free-text reply parsing.
- **Mobile Telegram Mini App (Web App):** Serves a responsive Liquid Glass dashboard over an automated Cloudflare Tunnel (`cloudflared`), giving the developer a real-time workstation status pulse, quota meters, and task abort controls from anywhere in the world.
- **Persistent Telegram Dock Keyboard:** Features quick navigation buttons (`[📊 Cockpit]`, `[💬 Chats ▾]`, `[🤖 Model ▾]`).

### 2.7 Self-Learning Voice Dictation Engine
Clanker provides low-latency speech-to-text dictation with adaptive domain vocabulary (`lib/voice-capture.js`, `lib/voice-learn.js`):
- **DirectShow Audio Pipeline:** Uses Node subprocesses spawning FFmpeg to capture audio directly from Windows DirectShow input devices without webview sandbox permission headaches.
- **Real-Time PCM Volume Streaming:** Calculates RMS, peak, and perceptual speech energy every 40ms, streaming normalized values to the webview to drive a liquid audio waveform visualizer.
- **Transcription & Jargon Learning:** Transcribes audio via Groq Whisper with technical domain prompts. It performs LCS (Longest Common Subsequence) diffing and bigram Dice similarity between what was heard and what the user actually submitted, automatically extracting respellings, camelCase variable names, and project jargon into `voice-dictionary.json`.

### 2.8 Visual Editor AI Bridge (Decoupled v1 Protocol)
Per `astro-visual-editor/docs/ai-bridge-interface.md`, Clanker Controller is strictly decoupled from the Astro Visual Editor (`vscode-extension/`):
- Communication occurs exclusively through VS Code commands (`aiChatPanel.bridge.info`, `aiChatPanel.routePrompt`, `aiChatPanel.injectPrompt`, `aiChatPanel.runNextBatchInCleanSession`).
- Neither extension imports files or shares runtime memory with the other, ensuring clean boundary preservation.

### 2.9 Liquid Glass UI & Kinetic Ergonomics
Clanker's UI (`media/`) is engineered to Apple Liquid Glass standards:
- **Mathematical Squircles:** Employs superellipse math paths ($|x|^5 + |y|^5 = 1$) for chat bubble geometry and tail contours.
- **Dual-Ring Concentric Meters:** Displays 5h and 7d quota windows simultaneously as SVG rings that expand into detailed countdown pills on hover.
- **Living Syntax & Math:** Integrates Shiki for syntax-highlighted code blocks with one-click copy buttons, and KaTeX for LaTeX equations.
- **Thinking Accordions:** Collapsible, streaming reasoning blocks for extended-thinking models.

---

## 3. Deep Research: The Modern CLI Wrapper & Coding Agent Ecosystem

To understand what Clanker Controller is missing, we must benchmark it against the leading closed-source and open-source CLI coding agents and wrappers.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    THE MODERN CODING AGENT LANDSCAPE                        │
├───────────────────────────────────┬─────────────────────────────────────────┤
│ CLOSED-SOURCE & VENDOR SPECIFIC   │ OPEN-SOURCE & UNIVERSAL WRAPPERS        │
├───────────────────────────────────┼─────────────────────────────────────────┤
│ • Anthropic Claude Code           │ • Aider (Paul Gauthier)                 │
│   (Terminal agentic loop, MCP,    │   (Tree-Sitter repo map, Git undo,      │
│   cost tracking, prompt caching)  │   auto-lint/test repair, dual-model)    │
│ • OpenAI Codex / Operator         │ • OpenRouter & OpenCode                 │
│   (JSON-RPC App Server,           │   (Universal model routing, provider    │
│   sandboxing, review commands)    │   failover, live USD cost accounting)   │
│ • Cursor / Windsurf Cascade       │ • Cline / Roo Code                      │
│   (Semantic vector indexing,      │   (Universal MCP hub, custom personas,  │
│   terminal error auto-fix)        │   Playwright browser automation)        │
│ • GitHub Copilot CLI              │ • Goose (Block) & OpenHands             │
│   (Command explanation, shell)    │   (Sandboxed Docker execution, recipes) │
└───────────────────────────────────┴─────────────────────────────────────────┘
```

### 3.1 Closed-Source / Proprietary CLI Agents

#### Anthropic Claude Code
Anthropic's official terminal agent (`claude`) represents the state of the art in native single-provider agentic workflows:
- **Agentic Loop & Tool Execution:** Operates through a tight Read-Plan-Act-Verify cycle with native tools for Glob, Grep, File Read, File Edit, Bash Execution, Web Search, and Web Fetch.
- **Subagent Delegation (`Task` / `Agent`):** Can spawn subagents in isolated context windows to investigate specific subtasks or run parallel research without bloating the parent context.
- **Prompt Caching Optimization:** Heavily optimized for Anthropic's prompt caching architecture, achieving 90%+ cache hit rates on repetitive repository contexts.
- **Cost & Token Transparency:** Features built-in `/cost` tracking, reporting exact session costs in USD, input/output token counts, and cache read/write breakdowns.
- **Project Rule Enforcement:** Reads `CLAUDE.md` hierarchical memory files at the project root and subdirectories to strictly follow repository guidelines.
- **Native Context Compaction:** Automatically inserts compaction boundaries when approaching context limits, ensuring continuous execution.

#### OpenAI Codex CLI & Codex App Server
OpenAI's desktop agent engine provides structured programmatic control:
- **JSON-RPC App Server Protocol:** Exposes a rich, typed bidirectional schema over stdio, enabling external controllers to manage threads, turns, and approval handshakes cleanly.
- **Fine-Grained Sandboxing:** Provides formal security policies (`dangerFullAccess`, `workspaceWrite`, network isolation).
- **Built-in Inspection Commands:** Features native `/review` (inspects and critiques uncommitted git changes), `/goal` (tracks persistent high-level objectives), and `/status`.

#### Cursor & Windsurf (Cascade)
Modern AI-native IDEs emphasize deep codebase indexing and terminal awareness:
- **Semantic Codebase Indexing:** Combines vector embeddings with lexical search (Ripgrep) and Tree-Sitter AST graphs to retrieve only the most relevant code snippets.
- **Terminal Error Auto-Fix:** Listens to terminal exit codes and stderr; when a build or test fails, it offers a single-click auto-repair prompt containing the error stack and offending source file.
- **Spec-Driven Architecture:** Generates an upfront specification/diff plan before executing multi-file edits.

---

### 3.2 Open-Source Universal Coding Agents & Wrappers

#### Aider (by Paul Gauthier)
Widely considered the gold standard for open-source CLI coding tools, Aider introduces several architectural innovations:
- **The Repo Map (Tree-Sitter AST Graph):** Rather than reading entire files or blindly searching, Aider parses the whole repository using Tree-Sitter to extract function signatures, class definitions, types, and exported symbols. It compresses this graph into an optimized ~1,000-token map included in every prompt, giving the LLM complete structural awareness of the entire codebase at near-zero token cost.
- **Git-First Architecture & Instant `/undo`:** Every successful modification turn is automatically committed to git with a clean, descriptive semantic commit message. If the agent makes a mistake, the user simply runs `/undo` to instantly revert the commit and working tree to the clean prior state.
- **Automated Test & Lint Self-Correction:** When configured with test or lint commands (e.g. `pytest`, `npm test`, `eslint`), Aider automatically runs the test suite after editing files. If the test fails, Aider captures the stack trace, feeds it back into the model, and iterates until the tests pass—without human intervention.
- **Architect + Editor Dual-Model Pattern:** Dispatches planning and reasoning to an elite, high-reasoning model (e.g. Claude Opus, o1/o3-mini), then hands the resulting diff specification to a cheaper, lightning-fast editor model (e.g. Claude Sonnet, DeepSeek V3, GPT-4o-mini) to perform the physical file edits.
- **Multi-File Context Management:** Provides explicit `/add` and `/drop` commands for surgical file tracking.

#### OpenRouter & OpenCode
The OpenRouter ecosystem provides universal model access and resilience:
- **Universal Model Aggregation:** Access to 200+ models (Claude 3.7, DeepSeek R1/V3, Llama 3.3, Qwen 2.5 Coder, Mistral) through a single unified API key and endpoint.
- **Automatic Provider Failover:** If Anthropic or OpenAI experiences an API outage or rate-limit spike, OpenRouter can automatically fall back to alternative providers or data centers without interrupting the user's turn.
- **Real-Time Financial Cost Tracking:** Precisely calculates USD expenditure down to fractions of a cent per request based on live token pricing.

#### Cline (formerly Claude Dev) / Roo Code
An open-source VS Code extension that excels at tool extensibility and autonomy:
- **Native MCP (Model Context Protocol) Client Hub:** Connects to any local or remote MCP server (PostgreSQL, GitHub, Brave Search, Figma, Playwright, Memory), dynamically exposing tools and resources to any connected model.
- **Custom Persona Modes:** Offers customizable modes (Code, Architect, Ask, Review, Test) with tailored system prompts and restricted tool permissions.
- **Interactive Hunk-by-Hunk Diff Review:** Allows developers to inspect diffs hunk-by-hunk, accepting or rejecting individual changes before they touch disk.
- **Browser Automation via Playwright:** Launches headless or visible browsers, takes screenshots, clicks elements, and visually inspects web apps to verify frontend implementations.
- **Checkpoint Time-Travel:** Maintains a snapshot timeline allowing users to roll back the file system to any historical turn.

#### Goose (by Block) & OpenHands
Autonomous agent frameworks focused on enterprise reliability and isolation:
- **MCP-Native Architecture:** All internal tools are implemented as standard MCP servers.
- **Docker/Container Isolation:** Runs agent commands within sandboxed Docker containers, ensuring untrusted bash commands cannot damage host environments.
- **Reusable Automation Recipes:** Allows saving repeatable multi-step workflows as YAML recipes that can be scheduled or triggered on demand.

---

## 4. Architectural Capability Matrix

The following matrix compares **Clanker Controller** directly against the top commercial and open-source tools:

| Feature Dimension | Clanker Controller | Claude Code | OpenAI Codex | Aider | Cline / Roo Code | OpenRouter / OpenCode |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Multi-Agent Orchestration** | 🏆 **Native Triad** (Claude, Codex, Gemini) | Single (Claude) | Single (Codex) | Multi-vendor API | Multi-vendor API | 🏆 Multi-model Hub |
| **Predictive Quota Telemetry** | 🏆 **5h & 7d Concentric Rings** | Basic `/usage` | Basic `/status` | None | None | None |
| **Quota-Gated Task Scheduling** | 🏆 **Auto-Delay until Reset** | None | None | None | None | None |
| **Remote Mobile Cockpit** | 🏆 **Telegram Bot + Mini App** | Claude App Bridge | None | None | None | None |
| **Voice Dictation & Learning** | 🏆 **DirectShow + Jargon Learn** | None | None | Voice in CLI | None | None |
| **Automated Test/Lint Auto-Fix** | ❌ **Missing** | Partial (manual) | None | 🏆 **Full Loop** (`--test`) | Partial | Partial |
| **Git Turn Checkpoint & `/undo`** | ❌ **Missing** (Diff-only) | Manual git | None | 🏆 **Auto-Commit + Undo** | 🏆 **Snapshot Checkpoints** | None |
| **Codebase Semantic Index** | ❌ **Missing** | Local Grep/Glob | Native tool | 🏆 **Tree-Sitter Repo Map** | Grep/Glob | Grep/Glob |
| **Interactive Hunk Diff Review** | ❌ **Missing** (Read-only) | Terminal prompt | Native Diff | Split diff | 🏆 **Hunk-by-Hunk Accept** | None |
| **MCP Client & Server Registry** | ⚠️ Partial (Codex pass-through) | 🏆 **Native MCP** | Native MCP | None | 🏆 **Full MCP Hub** | None |
| **Cost Accounting (USD / Session)**| ⚠️ Token counts only | 🏆 **USD `/cost`** | None | 🏆 **USD / Turn** | 🏆 **USD / Context** | 🏆 **USD / Token** |
| **Universal API Bridge (OpenRouter/Ollama)**| ❌ **CLI Only** (3 binaries) | None | None | 🏆 **Universal API** | 🏆 **Universal API** | 🏆 **Universal API** |
| **Dual-Model Chaining (Plan/Edit)**| ⚠️ Auto-split (not chained) | None | None | 🏆 **Architect/Editor** | 🏆 **Custom Modes** | None |
| **Composer `@` Token Autocomplete**| ⚠️ File picker button | None | None | `/add` tracking | 🏆 **`@file`, `@symbol`** | File references |
| **Browser Visual Automation** | ⚠️ Astro bridge only | Built-in Web | None | Web fetch | 🏆 **Playwright Browser** | None |

---

## 5. Prioritized Feature Gap Analysis (Ranked by User Impact)

The following features are currently missing from Clanker Controller. They are strictly sorted by **how much a typical software engineer using this product on a daily basis would miss them**, grouped into three distinct priority tiers.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    MISSING FEATURES RANKED BY USER IMPACT                   │
├─────────────────────────────────────────────────────────────────────────────┤
│  TIER 1: VITAL / HIGH-IMPACT (Daily Developer Friction Points)              │
│  1. Automated Test & Lint Self-Correction Loop ("Make it Green" Loop)       │
│  2. Turn-Level Git Checkpointing & Instant Undo (/undo)                    │
│  3. Tree-Sitter Semantic Codebase Map (Structural Repo Awareness)          │
│  4. Interactive Hunk Diff Inspector & Partial Patch Staging                │
│  5. Native MCP (Model Context Protocol) Client & Registry Hub              │
│  6. Composer Inline `@` Token Autocomplete (@file, @symbol, @git)          │
├─────────────────────────────────────────────────────────────────────────────┤
│  TIER 2: IMPORTANT / MEDIUM-HIGH IMPACT (Power-User & Efficiency Boosts)   │
│  7. Universal Model Hub & OpenRouter / Local LLM (Ollama) API Bridge       │
│  8. Financial Cost & Token Spend Dashboard (Real USD Accounting)           │
│  9. Dual-Model Chaining: Sequential "Architect-to-Editor" Pipeline         │
│  10. Headless Web Browsing & Visual UI Regression Verification             │
│  11. User-Configurable Persona Modes & Workspace Rules (.clankerrules)      │
├─────────────────────────────────────────────────────────────────────────────┤
│  TIER 3: QUALITY-OF-LIFE & SPECIALIZED CAPABILITIES                         │
│  12. Non-Linear Conversation Tree Branching & Forking                      │
│  13. Integrated Background Dev Server & Daemon Process Supervision         │
│  14. Acoustic Identity Synthesis (Astromech Droid Audio Feedback)          │
│  15. Structured Multi-Phase Batch Refactoring Orchestrator                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

### Tier 1: Vital / High-Impact Features (Immediate Daily Friction Points)

These are the capabilities that developers notice and miss immediately during everyday coding sessions. Their absence directly causes workflow interruption, manual verification overhead, or accidental code regressions.

#### 1. Automated Test & Lint Self-Correction Loop ("Make it Green" Auto-Repair)
* **The User Pain Point:** Currently, when an agent in Clanker finishes writing or editing code, it concludes the turn. The developer must manually switch to a terminal, execute `npm test` or `eslint`, inspect the error output, switch back to Clanker, copy-paste the error trace into the composer, and prompt the agent to fix it. This breaks developer flow and wastes significant time on mechanical copy-pasting.
* **How Others Solve It:**
  - **Aider:** Features `--test-cmd "npm test"` and `--auto-lint`. When an edit is completed, Aider automatically runs the test suite. If the exit code is non-zero, it captures stdout/stderr, feeds it back to the model with an automated prompt (*"Tests failed after your changes, please fix them"*), and repeats up to a configurable retry limit until tests pass.
  - **Claude Code:** Automatically detects and runs test commands when modifying core modules, capturing errors and re-prompting itself.
* **Proposed Implementation for Clanker:**
  - Introduce an optional `autoVerify` configuration in Clanker settings and a toggle pill in the composer (`[⚡ Auto-Verify: On]`).
  - Read project verify scripts from `package.json` (`npm run verify`, `npm test`) or a workspace config.
  - When `StreamEngine` receives a `turn_complete` after file edits, instead of immediately settling the turn, it runs the verify command. If it fails with exit code $\ne 0$, it appends a synthetic tool result with the error output and triggers an automatic corrective turn.

#### 2. Turn-Level Git Checkpointing & Instant Undo (`/undo` / Hunk Reversion)
* **The User Pain Point:** LLMs frequently produce code edits that introduce subtle bugs, break styling, or delete desired logic. Currently in Clanker, if an agent makes bad edits across 5 files, the user must manually navigate git in the terminal or VS Code Source Control to discard changes or reconstruct what was broken.
* **How Others Solve It:**
  - **Aider:** Every turn is a discrete, atomic git commit with an auto-generated semantic message (`fix: update AST parser for Astro components`). Typing `/undo` cleanly rolls back the git HEAD by 1 commit.
  - **Cline / Roo Code:** Takes snapshot checkpoints before each edit phase. A visual scrubber allows the user to restore the entire workspace to the exact state before any turn.
* **Proposed Implementation for Clanker:**
  - Leverage Clanker's existing `gitSnapshot` infrastructure in `lib/stream-engine.js` (which currently only takes snapshots for diff computation).
  - Add an atomic **"Rollback Turn"** button on every completed assistant bubble and an `/undo` slash command.
  - When invoked, Clanker executes `git checkout <turn_snapshot_hash> -- .` or applies a reverse patch, restoring the workspace instantaneously.

#### 3. Tree-Sitter / Semantic Codebase Map (Structural Whole-Project Awareness)
* **The User Pain Point:** When working on complex multi-file projects, agents in Clanker either hallucinate imports and function signatures, or spend dozens of tool calls running `grep`, `glob`, and `view_file` just to understand where types and classes live. This wastes context tokens and degrades response quality.
* **How Others Solve It:**
  - **Aider's Repo Map:** Uses Tree-Sitter to parse every source file in the repository, extracting class names, method signatures, exported types, and relationships. It uses PageRank to prioritize symbols related to the user's prompt, building a token-dense (~1,024 tokens) structural outline injected into the system prompt.
  - **Cursor:** Builds an offline AST symbol graph indexed with vector embeddings.
* **Proposed Implementation for Clanker:**
  - Add a lightweight, background Tree-Sitter indexing service (`lib/repo-map.js`) that runs once at activation.
  - Cache symbol signatures across the workspace.
  - Inject the relevant symbol map into the auto-router's turn briefing so agents know all function names, signatures, and file locations upfront.

#### 4. Interactive Hunk Diff Inspector & Partial Patch Staging
* **The User Pain Point:** Currently, Clanker renders diffs inside a read-only tool card (`editDiff`, `codexDiff`) that is strictly informational and capped at 300 lines. The user has no ability to accept Hunk 1 while rejecting Hunk 2, or edit the proposed code before it touches disk.
* **How Others Solve It:**
  - **Cline / Roo Code:** Presents a rich interactive diff viewer prior to disk write, with `[Accept Hunk]`, `[Reject Hunk]`, and `[Revert]` controls for individual file blocks.
  - **Mentat:** Allows command-line interactive patch selection ($y/n/e$).
* **Proposed Implementation for Clanker:**
  - Upgrade Clanker's diff tool card in `media/main.js` from static syntax-highlighted HTML to an interactive hunk review card.
  - Allow users in `ask` permission mode to uncheck specific hunks before clicking **[Allow]**. Clanker then strips the rejected hunks from the patch payload before execution.

#### 5. Native MCP (Model Context Protocol) Client & Server Registry in Clanker Hub
* **The User Pain Point:** While Clanker exposes Codex's internal `/mcp` commands, Clanker itself does not act as an MCP Client. If a developer wants Claude or Gemini to connect to a PostgreSQL database, GitHub issues, Figma designs, or a custom local tool via MCP, Clanker cannot broker it.
* **How Others Solve It:**
  - **Claude Code & Cline & Goose:** Feature full native MCP client hubs. Developers configure `mcpServers` in `claude_desktop_config.json` or IDE settings. The agent automatically discovers external tools (e.g. `query_database`, `fetch_github_issue`) and invokes them across any session.
* **Proposed Implementation for Clanker:**
  - Create a centralized MCP Manager (`lib/mcp-hub.js`) inside Clanker.
  - Read standard MCP configuration files (`~/.config/mcp/servers.json` or `.vscode/mcp.json`).
  - Expose discovered MCP tools dynamically to Claude Code, Codex, and Gemini through standard tool-use protocols.

#### 6. Inline Composer `@` Token Autocomplete (`@file`, `@symbol`, `@git`)
* **The User Pain Point:** Currently, attaching context in Clanker requires clicking the `+` attach button and choosing a file from a modal picker. Developers in fast flow want to type: *"Look at `@src/lib/quota-bridge.js` and update `@readQuotas` to handle undefined"* directly in the composer textarea.
* **How Others Solve It:**
  - **Cursor / Windsurf / Claude Code / Cline:** Typing `@` opens an instantaneous fuzzy search dropdown listing workspace files, symbols, git commits, and terminal outputs. Selecting an item inserts a clickable token that automatically injects the file contents into the prompt.
* **Proposed Implementation for Clanker:**
  - Extend `media/main.js` with an inline `@` trigger handler.
  - Query workspace files using `vscode.workspace.findFiles` and fuzzy-match symbols.
  - Render an Apple Liquid Glass floating menu anchored above the composer cursor.

---

### Tier 2: Important / Medium-High Impact Features (Power-User & Efficiency Boosts)

These features provide immense value to power users, cost-conscious developers, and multi-model workflow orchestrators.

#### 7. Universal Model Hub & OpenRouter / Local LLM (Ollama/vLLM) API Bridge
* **The User Pain Point:** Clanker is currently hardwired to three specific local CLI binaries: `claude`, `codex`, and `agy` (Gemini). If a developer wants to use **DeepSeek R1/V3**, **Llama 3.3**, **Qwen 2.5 Coder**, or run models completely offline via **Ollama** or **vLLM**, Clanker cannot run them.
* **How Others Solve It:**
  - **OpenRouter / Aider / OpenCode:** Support universal OpenAI-compatible REST endpoints. Changing a configuration string routes prompts to any cloud model or local Ollama server seamlessly.
* **Proposed Implementation for Clanker:**
  - Introduce a 4th provider type in `lib/stream-engine.js`: `universal-rest`.
  - Connect to OpenRouter or local endpoints (`http://localhost:11434/v1`) using standard streaming chat completion protocol.
  - Expose OpenRouter models in the model picker pill (`DeepSeek R1`, `Qwen Coder`, `Llama 3.3 70B`).

#### 8. Financial Cost & Token Spend Dashboard (Real USD Accounting)
* **The User Pain Point:** While Clanker tracks sliding window quota percentages (5h and 7d meters), it does not track financial dollars spent. When developers run heavy reasoning models (Opus, o3-mini) or use paid API tiers, they have no visibility into whether a turn cost $0.02 or $2.50.
* **How Others Solve It:**
  - **Claude Code (`/cost`):** Reports total session cost, prompt token cost, completion token cost, and cache savings in USD.
  - **Cline:** Displays a live persistent dollar readout in the header (`$1.42 spent this session`).
* **Proposed Implementation for Clanker:**
  - Implement a pricing dictionary (`lib/token-pricing.js`) mapping models to input/output/cache token rates.
  - Track cumulative session spend and display a subtle currency pill in the launcher and chat header alongside the quota gauges.

#### 9. Dual-Model Chaining: Sequential "Architect-to-Editor" Pipeline
* **The User Pain Point:** High-reasoning models (Opus, o3-mini, Gemini Pro) excel at deep architectural planning but are slow and expensive at typing out 500 lines of boilerplate. Cheap models (Sonnet, GPT-4o-mini, DeepSeek) are fast and cheap at writing code but struggle with architectural planning.
* **How Others Solve It:**
  - **Aider Architect Mode:** Automatically executes a two-stage turn:
    1. *Stage 1 (Architect):* Opus or o3-mini analyzes the problem, formulates the strategy, and writes a detailed diff plan.
    2. *Stage 2 (Editor):* Sonnet or GPT-4o takes the architect's plan and mechanically applies the file edits.
* **Proposed Implementation for Clanker:**
  - Add an **Architect + Editor** routing preset in `lib/auto-router.js`.
  - When enabled, Clanker sends the prompt to Gemini or Opus for planning, captures the Markdown plan, and automatically dispatches a clean follow-up turn to Codex or Sonnet to execute the diffs.

#### 10. Headless Web Browsing & Visual UI Regression Verification (Playwright)
* **The User Pain Point:** Clanker has an AI bridge to the Astro Visual Editor, but when an agent modifies a frontend component, Clanker cannot autonomously take a screenshot, verify that the element renders correctly without layout shifts, or inspect browser console errors.
* **How Others Solve It:**
  - **Cline / Roo Code / OpenHands:** Features a headless browser tool powered by Playwright. The agent can navigate to `http://localhost:3000`, click interactive elements, capture viewport screenshots, and inspect DOM layout directly.
* **Proposed Implementation for Clanker:**
  - Add a lightweight Playwright runner service (`lib/browser-tool.js`).
  - Provide a browser tool to headless agents enabling them to capture screenshots and assert visual correctness during frontend tasks.

#### 11. User-Configurable Persona Modes & Workspace Rules Engine (`.clankerrules`)
* **The User Pain Point:** Clanker currently hardcodes role boundaries in `lib/auto-router.js` (`DIRECTIVES.gemini`, `DIRECTIVES.claude`, `DIRECTIVES.codex`). Users cannot easily add custom team rules, project coding style guidelines, or define custom agent personas without editing extension source code.
* **How Others Solve It:**
  - **Cursor (`.cursorrules`):** Reads project-specific instructions from the workspace root.
  - **Claude Code (`CLAUDE.md`):** Reads hierarchical markdown rule files.
* **Proposed Implementation for Clanker:**
  - Introduce support for `.clankerrules` and `.clanker/personas/` in the workspace root.
  - Allow users to define custom personas with specific system prompts, forbidden files, and tool access limits.

---

### Tier 3: Quality-of-Life & Specialized Capabilities

These enhancements provide visual polish, system resilience, and specialized convenience for edge-case workflows.

#### 12. Non-Linear Conversation Tree Branching & Forking
* **The User Pain Point:** If a conversation goes down an unproductive rabbit hole at turn 5, the user must either continue struggling in that context or start an entirely new chat from scratch.
* **How Others Solve It:** ChatGPT and Windsurf allow users to fork a conversation at any earlier message, creating a branching tree of alternative execution paths.
* **Proposed Implementation for Clanker:** Add a **"Fork from here"** icon on past user message bubbles, cloning the chat store up to that turn into a fresh session thread.

#### 13. Integrated Background Dev Server & Daemon Process Supervision
* **The User Pain Point:** Agents often need to restart local servers or keep build watchers alive. Currently, dev servers are managed outside Clanker via external npm scripts or the separate `vscode-extension`.
* **How Others Solve It:** OpenHands and Claude Code supervise long-running background tasks with dedicated health monitors and log streaming.
* **Proposed Implementation for Clanker:** Integrate a daemon runner inside Clanker that can start, restart, and monitor background processes, piping crash logs directly into agent context.

#### 14. Acoustic Identity Synthesis (Astromech Droid Audio Feedback)
* **The User Pain Point:** Per `astro-visual-editor/docs/clanker-controller-mascot-spec.md`, Clanker's brand identity specifies an **Astromech Droid / Modular Synthesizer (R2-D2 / BD-1 class)** acoustic persona with frequency-modulated electronic chirps and ascending glides. Currently, voice input is fully functional, but acoustic audio feedback is limited to standard Windows toast chimes.
* **Proposed Implementation for Clanker:** Implement the Web Audio API procedural oscillator engine defined in Section 4 of `clanker-controller-mascot-spec.md` (0 KB payload, pure sine/triangle wave sweeps) to chirp on task completion, warn on syntax errors, and purr during streaming turns.

#### 15. Structured Multi-Phase Batch Refactoring Orchestrator
* **The User Pain Point:** When executing massive refactors (e.g. migrating 30 files from CommonJS to ESM), running them in a single prompt causes context exhaustion or agent hallucination.
* **How Others Solve It:** Tools like Goose and OpenHands offer batch execution recipes that run isolated turns sequentially across a manifest of files.
* **Proposed Implementation for Clanker:** Build an interactive batch runner that ingests a list of target files and prompts, running clean sessions sequentially with automated git checkpoints between each file.

---

## 6. Implementation Roadmap & Architectural Recommendations

To evolve Clanker Controller into the absolute industry benchmark without violating the **Ponytail Law** (minimal diffs, stdlib over bloated dependencies, zero unnecessary complexity) or compromising its **Liquid Glass** aesthetic excellence, we recommend tackling the feature gaps in three focused phases:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    RECOMMENDED IMPLEMENTATION ROADMAP                       │
├─────────────────────────────────────────────────────────────────────────────┤
│  PHASE 1: WORKFLOW INTEGRITY & REVERSIBILITY (Weeks 1 - 2)                  │
│  ├── 1. Automated Test & Lint Verification Loop (Auto-fix on failed exit)  │
│  ├── 2. Turn-Level Git Checkpoints & Instant /undo Reversion                │
│  └── 3. Interactive Hunk Diff Inspector with Checkbox Staging               │
├─────────────────────────────────────────────────────────────────────────────┤
│  PHASE 2: CONTEXT INTELLIGENCE & CODEBASE AWARENESS (Weeks 3 - 4)           │
│  ├── 4. Tree-Sitter Repo Map (Token-dense structural codebase outline)      │
│  ├── 5. Composer Inline `@` Token Autocomplete for Files & Symbols          │
│  └── 6. Workspace Rules Engine (.clankerrules & Custom Personas)            │
├─────────────────────────────────────────────────────────────────────────────┤
│  PHASE 3: UNIVERSAL EXTENSIBILITY & METRICS (Weeks 5 - 6)                   │
│  ├── 7. Native MCP (Model Context Protocol) Client Hub                      │
│  ├── 8. Universal Model Bridge (OpenRouter & Local Ollama REST Provider)   │
│  ├── 9. Real-Time Financial Cost Tracking Dashboard ($ USD Accounting)      │
│  └── 10. Dual-Model Chaining (Architect + Editor Sequential Turn Pipeline)  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Architectural Design Guidelines for New Features:
1. **Preserve Native Decoupling:** Clanker Controller must remain completely independent of the Astro Visual Editor. All new capabilities must be implemented inside `tools/ai-chat-panel/`.
2. **Honor the AI Bridge Interface:** Any interaction between the editor and Clanker must continue through additive commands under `aiChatPanel.bridge.*` without breaking API v1 contracts.
3. **Respect Windows Sandbox Boundaries:** When executing shell commands or git operations on Windows, adhere strictly to native PowerShell execution, unelevated sandboxing, and `-LiteralPath` handling for paths containing spaces.
4. **Liquid Glass & Dynamic Island Compliance:** Every new UI element (diff inspectors, `@` menus, test status pills, cost meters) must visually fuse into existing Dynamic Island docks and frosted glass panels (`backdrop-filter: blur(24px)`), preserving Apple-grade tactile motion.

---

## 7. Conclusion

Clanker Controller already possesses architectural strengths that represent the frontier of developer tools: **tri-agent orchestration**, **predictive quota scheduling**, **zero-token usage probing**, **mobile Telegram cockpits with interactive approvals**, and **self-learning voice dictation**.

By systematically implementing the **Tier 1** capabilities—most notably the **Automated Test Self-Correction Loop**, **Instant Git Turn Undo**, **Tree-Sitter Codebase Mapping**, and **Inline `@` Token Autocomplete**—Clanker Controller will combine the raw execution power and safety of **Aider** and **Claude Code** with the unparalleled elegance, quota intelligence, and mobile autonomy that make Clanker unique.
