# Clanker Controller

Independent repository for the chat controller, native voice routing, and CLI usage display.

## Start here

For **“What's left to do on this project?”**, read [TODO.md](TODO.md). It is the single list of open work, with stable task IDs, next actions and completion criteria. Report interrupted work first, then ready tasks, then deferred ideas and items needing investigation. Reading the backlog doesn't authorize implementation of every item.

Read [AGENTS.md](AGENTS.md) before editing. Use the [documentation index](docs/README.md) to find current behavior, proposals and historical material. Old specs and their unchecked lists are context; they aren't another backlog. Check the working tree before resuming a task, since recent changes may already cover part of it.

## Repository map

| Folder | Owns |
|---|---|
| `ai-chat-panel/` | IDE extension, chat UI, project manager, scheduler and CLI runners |
| `voice-router/` | Native capture, transcription, vocabulary and prompt routing |
| `antigravity-usage-statusbar/` | Usage and quota status extension |
| `scripts/` | Browser checks for the chat controller and the Visor bridge |
| `docs/` | Current guides and specifications; [index](docs/README.md) |
| `docs/plans/` | Proposals linked to open tasks |
| `docs/archive/` | Historical specs and research, excluded from the active backlog |
| `assets/` | Master brand assets; extension runtime assets stay in its `media/` folder |
| `out/` | Ignored generated reports, screenshots and local experiments |

The extension folders are installed through junctions; keep their names and locations stable. Dependencies (`node_modules/`), UI baselines (`.ui-tester/`) and migration backups are local, ignored directories. `out/` may also contain recovery work or private checkouts; inspect it before deleting anything beyond known generated artifacts.

## Development

Run `npm.cmd install`, `npm.cmd run check`, and `npm.cmd test` from this folder. Browser checks use Playwright and the installed Edge browser. To install the unpacked extension, run `ai-chat-panel/install-into-antigravity.ps1 -Link`; an existing junction must point to this checkout.

First-run onboarding (`#cliSetupModal`, also reopenable anytime via **Chat Settings > General > Setup guide**) connects your installed coding CLIs (Claude Code, Codex, Antigravity, and GitHub Copilot), links directly to **Voice** (Groq Whisper dictation) and **Routing** (free Cloudflare + Groq Auto router), and includes **Set up with AI** to prefill a guided setup and provider-customization prompt. The GitHub Copilot CLI foundation lives in [`ai-chat-panel/lib/providers/copilot.js`](ai-chat-panel/lib/providers/copilot.js); see [docs/adding-a-provider.md](docs/adding-a-provider.md) to fine-tune flags, models, or stream events.

Use the [project guide](ai-chat-panel/PROJECTS.md) to choose the website, Visor, or Clanker as a chat's destination. They have independent Git roots. The current chat model supports one primary project per conversation; several open chats can target different repositories. Project registration doesn't itself grant or restrict filesystem access.

Visor is optional. The bridge smoke check discovers `../Visor` or `VISOR_DIR`. Clanker stores chats, schedules and attachments in per-user extension storage, so moving this source repository doesn't move that history.

Open chat editor tabs and pop-outs use Antigravity's native layout restoration. Leave them open when closing the IDE to reopen them in their saved locations with the same conversations and drafts. Each restored webview requests its conversation after its message listener is ready, including when several windows reopen together. Closing an individual chat tab removes it from that layout; its history remains in Manage Chats. Window placement depends on the IDE restoring its previous session.

## Usage windows and CLI maintenance

If Claude returns a Cloudflare-branded HTTP 403 authentication failure, Clanker pauses the affected chat queue and keeps the failed request first (or queues Continue if work was already performed). Further Claude sends are blocked until you explicitly allow a retry. Check the provider status page before retrying, then resume the paused queue manually. A successful local sign-in check alone cannot confirm that the provider has recovered.

Open chats linked to Codex check their native thread every two seconds for messages continued in ChatGPT. New prompts, reply text and supported tool records update automatically, including growing replies, while preserving the composer draft. Clanker waits while the external turn is active; stop that turn in ChatGPT. Sync requires the same locally accessible Codex thread and a running IDE. It pauses while Clanker runs its own turn. Deleted or forked threads, attachments and provider-specific UI may not mirror completely.

Codex permits only one writer per thread. ChatGPT may retain that ownership after its answer finishes. If Clanker reports it is waiting for the chat to be released, close the conversation in ChatGPT, or quit ChatGPT if it stays locked. Clanker keeps the pending prompt and retries every five seconds; Stop cancels it. Reading shared history does not grant simultaneous write access.

When a task hits its usage limit, Clanker automatically schedules Continue for the reset in the same chat, model and project, ahead of later prompts. This is on by default; turn off **Automatically continue after usage resets** in **Chat Settings > General** to use the manual Continue button instead. The IDE must remain running for scheduled prompts to dispatch.

Claude prompts waiting for the same reset share a deadline: reset readings up to one minute apart use the later time, including when restoring an older saved queue. Calendar schedules and separate usage windows keep their own times.

Drag the left handle to reorder scheduled prompts in the composer dock, including while another reply runs. Future prompts show a clock; ready prompts show a grip. Their saved order survives a reload. Scheduled prompts and ordinary queued turns each keep their own ordering group.

Scheduled rows show attached images/files with the same thumbnail and count badge as queued turns. Hover the badge for filenames; narrow windows reduce it to a compact count.

To continue with another provider, click **Change model** on the scheduled prompt, pick a model, and confirm with the checkmark. Changing providers removes the old provider's reset deadline and sends when the chat is idle and the selected provider has usage and is signed in. Changing models within the same provider keeps its reset wait. **Ctrl+Enter** from the edited composer steers immediately; ordinary confirmation keeps the prompt queued. Calendar and timer schedules retain their chosen time.

**Start usage windows early** (**Chat Settings > General**, on by default) keeps each provider's 5-hour window (plus Gemini 4 Argon's separate 7-day window on Pro plans) rolling in the background, so one is nearly always already under way when you start. Whenever a window isn't running and no prompt is queued for its usage reset (that prompt starts the window itself), Clanker sends "respond with 1" to the cheapest model of that pool (`Gemini 4 Argon Low` for Argon), from an empty temporary folder with tools and project settings off. It only applies to CLIs signed in with a subscription: one that is billed per token through an API key (an API key in its environment or settings, or Codex in API-key mode) is never pinged. That repeats every 5 hours (7 days for Argon; a failed ping is retried up to 3 times, 10 minutes apart). The settings row shows what each ping used. The IDE must be running.

**Cloud usage windows** (**Chat Settings > General > Start windows in Google Cloud**, off by default) can run Claude Code and Codex warmups against a weekly work calendar while the PC is off, in your own Google Cloud project. It requires the Google Cloud CLI, billing-enabled project, deployment and separate cloud subscription sign-ins. Google Cloud may charge for incorrect setup or usage outside its shared free allowances. There is no shared Clanker backend. Antigravity is not supported by the cloud runner. See [setup, costs, credentials, pause and removal](docs/cloud-usage-windows.md).

Migration recovery files live in `.migration-backup/`, which Git ignores. Visor holds the original Git bundle and working-tree snapshot. No GitHub remote or push is implied by the split.

**Automatically update idle CLIs** (**Chat Settings > General**, on by default) silently installs available updates for connected providers when they have no active work and you have not typed with that provider for 30 seconds. Claude can update while you use ChatGPT/Codex, and vice versa. Typing in Auto mode protects all providers until the idle period ends. Versions are checked at startup and every 6 hours; deferred updates are reconsidered every 15 seconds. Failed attempts wait 6 hours before retrying and remain available for manual update. Turn the toggle off to update manually. The IDE must remain running.

Pending updates and failed attempts also recheck the installed version every minute and when Settings opens. If another updater finishes, Clanker refreshes the version, clears stale errors and removes the update button automatically, without an IDE reload. This status refresh also runs when automatic installation is off.
