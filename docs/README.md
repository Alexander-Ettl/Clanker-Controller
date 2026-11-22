# Documentation index

Start at the [root README](../README.md). For remaining work, use [TODO.md](../TODO.md), the single backlog. A guide describes behavior, a plan proposes a change, and an archived document records earlier work. None of their embedded checklists overrides the backlog.

## Working on the project

| Read | When |
|---|---|
| [Agent instructions](../AGENTS.md) | Before edits or commands |
| [Development guide](development.md) | Repository map, install, checks, usage windows and CLI maintenance |
| [Publishing](publishing.md) | Marketplace and Open VSX packages, publisher setup and release steps |
| [Chat extension](../ai-chat-panel/README.md) | Architecture, installation, voice input and local checks |
| [Projects and storage](../ai-chat-panel/PROJECTS.md) | Project selection, chat ownership and repository boundaries |
| [Chat storage and recovery](chat-recovery.md) | Backup location, automatic restore, and protection against Full Access tools |
| [Voice router](../voice-router/README.md) | CLI/daemon setup, capture, routing and batch commands |
| [Usage status extension](../antigravity-usage-statusbar/README.md) | Statusbar setup and usage checks |
| [UI tester](ui-tester.md) | Browser fixtures, reports and visual verification |
| [Extension discovery](antigravity-extension-discovery.md) | Antigravity installation troubleshooting; check old example paths before use |

## Current guides and contracts

| Area | Documents |
|---|---|
| UI and assets | [Dynamic Island composer rules](dynamic-island-composer-spec.md), [mascot assets and motion](clanker-controller-mascot-spec.md) |
| Provider integration | [Adding a provider](adding-a-provider.md), [routing configuration](routing-config.md), [Visor bridge](ai-bridge-interface.md), [cross-vendor agents](agent-bridge.md) |
| Voice | [Microphone and dictionary](microphone-dictionary-review.md), [OpenWhispr privacy](openwhispr-privacy.md) |
| Usage windows | [Google Cloud setup, costs and removal](cloud-usage-windows.md); local warmups and automatic updates are in the [development guide](development.md#usage-windows-and-cli-maintenance) |
| Loops | [Loop guide](loops.md); LOOP-01 tracks reconciliation with recent work |
| Remote access and compliance | [Telegram setup](telegram-setup.md), [Telegram risks](telegram-security-and-risks.md), [EU compliance notes](compliance-eu.md) |
| Performance already implemented | [Paged chat history](chat-performance.md), [rendering and persistence improvements](performance-implementation.md), [interaction benchmark](interaction-performance.md) |

The [21 October performance audit](performance-opportunities.md) records an earlier state. Read its implementation follow-up first; TODO lists the unresolved investigations. Reports under `out/` are local evidence and may be missing in a fresh checkout.

## Proposals linked to open work

| Task | Plan | Status |
|---|---|---|
| CONTEXT-01 | [Recent chat context icons](plans/recent-chat-context-icons.md), [contact sheet](plans/recent-chat-context-icons-sheet.html) | Built; off until `aiChatPanel.workContextIcons` is set; free only |
| LOOP-01 | [Loop redesign](plans/loop-redesign.md) | Interrupted integration; reconcile against existing changes |
| SEARCH-01 | [Manage Chats message search](plans/manage-chats-search-plan.md) | Deferred research; benchmark before choosing a dependency |

[Batch synthesis workflow](batch-synthesis-workflow.md) is design context spanning Clanker and Visor. The [voice-router guide](../voice-router/README.md) describes the existing batch CLI; proposed editor workflows aren't automatically open Clanker tasks.

## Historical designs and research

Files in `archive/` preserve design history. Their approval labels, old repository paths, unchecked tasks and agent prompts aren't instructions to resume work. Revalidate any technical or external-product claims before reuse.

| Document | Why retained |
|---|---|
| [Original chat studio](archive/ai-chat-studio-architecture.md) | Phase 13 design before the current extension and repository layout |
| [Multiline composer](archive/ai-chat-panel-codex-multiline-spec.md) | Earlier composer blueprint; current contract is the Dynamic Island spec |
| [Interruption and queues](archive/ai-chat-panel-task-interruption-and-queuing-spec.md) | Original implementation handoff; inspect current turn/queue code before reuse |
| [Auto-continue on limits](archive/ai-chat-panel-auto-continue-on-limit-spec.md) | Earlier implementation checklist; current behavior is documented in README |
| [Feature gap analysis](archive/clanker-controller-feature-gap-analysis.md) | Unselected ideas and older capability comparisons |
| [Standalone application roadmap](archive/clanker-studio-standalone-architecture-and-roadmap.md) | Alternative product proposal, not the architecture of this checkout |
| [Loop-manager UI brief](archive/claude-investigation-manager-prompt.md) | Explicitly superseded by the implemented manager UI |

## Visual references and generated files

[Mascot preview](clanker-preview.html), [routing explainer](model-router-explained.html) and the [voice-router presentation](../voice-router/presentation.html) are standalone visual references. They aren't runtime entry points or task lists. `clanker-frames/` contains reviewed mascot reference images; runtime artwork remains in `ai-chat-panel/media/`, and `assets/` holds the master logo.

Use `out/` for generated reports and `out/screenshots/` for ad hoc screenshots. The microphone and project-rail checks now default there regardless of the shell's working directory; explicit screenshot overrides still work. Cleanup on 2026-10-22 moved five loose screenshots there and removed the empty tracked `ai-chat-panel/pipe` artifact after checking references. The ignored PDF.js extraction cache remains at `out/pdfjs-package/`.

Keep recovery folders, private loop workspaces, migration backups, UI baselines, recordings and user storage separate from disposable reports. No storage migration or runtime-folder move was part of this organization pass.
