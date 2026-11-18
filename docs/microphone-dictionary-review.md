# Microphone routing and correction dictionary

Reviewed 2026-10-04. The implementation belongs to Clanker Controller.

## Current route

The chat microphone records through the native ffmpeg capture and calls Groq:

1. `whisper-large-v3-turbo` turns audio into text.
2. `openai/gpt-oss-120b` cleans the text using the existing dictation-only prompt.
3. The result lands in the chat composer for review. It is never sent automatically.

The microphone's old intent classification and provider-role routing have been
removed from the chat path. Dictation preserves the model picker, including Auto.
The current chat router runs when you send and uses the current routing settings;
dictation does not preselect an agent. Dictionary learning remains deterministic.

GPT-OSS 120B is the cleanup model, not the audio recognizer. `GROQ_WHISPER_MODEL`
and `GROQ_MODEL` can override these defaults. No model overrides were found in
the local voice-router `.env` or this review's process environment; the running
IDE may have inherited different values.

Keep this route as the baseline. Groq documents Turbo as its multilingual
price/performance option and full `whisper-large-v3` for error-sensitive use.
A switch to full V3 should follow a comparison using representative German/English
recordings, names and technical terms. This review did not record real audio or
measure the user's word error rate.

If cleanup fails after transcription succeeds, Clanker now returns the raw
transcript as an editable draft and reports the cleanup error. Empty
transcriptions report that no speech was detected.

## Correct a word

1. Click the microphone or use the configured dictation shortcut, speak, and stop.
2. Edit a misheard word in the chat composer. For example, change `tech no matrix`
   to `Tecnomatix`.
3. After a 700 ms typing pause, Clanker detects plausible spelling corrections
   and shows **Adding “Tecnomatix” to dictionary** above the composer, with a
   ten-second countdown and a shrinking progress line.
4. Click the trash button during those ten seconds to prevent the addition.
   Otherwise Clanker saves automatically and confirms it. Cancellation dismisses
   that word for this recording. A failed save reports the error and offers
   **Retry**, which starts another ten-second cancellation window.
5. On the next recording, saved terms are passed to Whisper as vocabulary hints
   and to GPT-OSS as correctly spelled vocabulary for cleanup.

Detection and saving are automatic, with a visible cancellation window before
the write. Clanker monitors the editable draft
without OpenWhispr's 30-second limit; it stops on send, clear, or chat navigation.
It does not monitor other apps or edits to previously sent messages.

Text typed before the recording is excluded. Editing that prefix stops detection
for the recording. Switching chats or clearing a draft invalidates pending
suggestions and cancels their timers. Further typing cancels pending additions;
the next detection starts a new countdown. Sending ends edit monitoring but still
shows detected additions with their cancellation window. Hiding the chat pauses
the countdown, so time spent away does not consume the opportunity to cancel.
Ordinary rephrasing is filtered by the existing word-diff heuristic; short spelling
changes, casing corrections and technical identifiers can produce suggestions.

The dictionary is stored as `voice-dictionary.json` in Clanker's extension session storage. It is not
written into a project. Every registered project has its own words, and a small **shared** list works in all of them.
Existing OpenWhispr dictionary entries are also read when available, without modifying its database, and count as
shared words. Dictionary hints increase recognition likelihood; they do not guarantee exact replacement.

Nothing here calls a model. Scanning, ranking, learning and suggestions are deterministic: the same file and the same
project give the same words in the same order.

### Managing the dictionary

**Settings → Voice → Dictionary** opens on the dictionary of the project you are working in. The picker above the list
switches to the shared words, another project, or all words. Search it, add a word (it goes to the dictionary on show),
double-click or use the pencil to rename one, switch a word off without losing it, or delete it. The globe button shares a
project word with every project; the folder button on a shared word keeps it for one project only.

**Scan all projects** is the first-time setup. It reads every registered project's folder one after the other, shows
progress, and lists per project how many words were added, refreshed or dropped (a project without a folder is skipped,
and one that fails does not stop the rest). The project buttons below it scan one project again. A scan is local and
read-only, skips dependency, build, secret and `.gitignore`d folders, and never follows links. It finds:

- the project name and the names in its manifests (`package.json` with its dependencies, `Cargo.toml`, `pyproject.toml`, `go.mod`);
- glossary entries from files named glossary, terminology or similar;
- the names of the project's own folders, when they are compound names such as `voice-router`;
- classes, functions and types the project defines (not local variables, test helpers, standard-library calls or plain
  plumbing names such as `createdAt`);
- name-like headings, repeated Title Case phrases such as "Dynamic Island", and capitalised product names that the docs
  never write in lowercase (Nextcloud, Whisper);
- acronyms (GPU, NDJSON) that the project never uses as ordinary words.

Words are ranked by how many distinct files use them, so a product name in six files beats a helper repeated two hundred
times in one. The best 80 go in, no more than about half of them identifiers. A rescan refreshes the weights, drops scanned
words it no longer finds (unless you used them), adds new ones, and never touches words you chose or deleted from a scan.

**Edit with AI** puts a prompt in the composer that tells a chat model the file format, the project ids and the limits;
the file is watched, so the list updates when the model saves it. Words from a scan are tagged *scan* and can be removed
together for the project on show (or for all).

### How it learns

- A correction you accept in the composer, and a word you add by hand, go to the project the chat belongs to.
- A word counts as used once per message you send, in the project it was sent from. Pasted code, links and paths are
  ignored; so is anything the assistant writes.
- An unfamiliar name-like term (camelCase, an acronym, capitals with digits) that appears in three separate messages in a
  project is **suggested** under the list: *Add* puts it in that project, the cross dismisses it for good.
- A project word you also used in another project is **suggested for sharing**. Scan frequency alone never promotes a
  word. Suggestions are never applied on their own.

### Limits

| What | Limit |
| --- | --- |
| Words in the file | 5,000 (a hand edit beyond that still works: only the limits below reach the models) |
| Words from scans | 1,500 in total, 150 per project, 80 per scan; a word you delete is not re-added by the next scan |
| Whisper `prompt` | the 40 best-ranked enabled words and at most 480 characters (it holds ~224 tokens) |
| Cleanup prompt | the 150 best-ranked enabled words |
| Shared words | at most a quarter of any prefix of the ranked list, so one busy project cannot crowd out another |
| One word | 60 characters |

For a recording, Clanker takes the chat project's own enabled words and the shared ones (and OpenWhispr's); another
project's words are never included. If a project has its own spelling of a shared word, the project's wins. Each word gets
a score: a base by origin (a corrected word 3, hand-added 2.5, OpenWhispr 2, AI-added 1.5, a scanned word its scan weight
of 0.6 to 3), a bonus for recent use (fading over about a month) and for how often it was used, a bonus when it was used in
this project, and a short head start for a new word. Ties break alphabetically, so there is no randomness. The two lists are
then merged by score with the shared words held to their quarter. `uses`, `lastUsedAt` and `usedIn` (uses per project id)
are bookkeeping in the file; leave those fields alone when editing by hand. Settings shows only the number of words,
not which ones are sent. A scan reads at most 1,200 files, 256 KB per file, 6 MB in total and 5 seconds, then stops and
says so.

### File format

`{ "version": 2, "terms": [{ "term", "enabled", "addedAt", "projectId"?, "source"?, "weight"?, "uses"?, "lastUsedAt"?, "usedIn"? }], "ignored": [], "pending": {} }`.
A word with a `projectId` belongs to that project; one without is shared. A word is unique per project and among the
shared ones, ignoring case. The first time an older single-list file is read, scanned words go to the project they were
scanned from and a word used only in one project (three or more times) goes there; everything else stays shared, so no
word stops working. The old file is kept once as `voice-dictionary.json.v1.bak`. `ignored` remembers deleted scan words
and dismissed suggestions per project; `pending` counts unfamiliar terms. Words of a project that was removed stay in the
file under *All words* until you delete them.

## References and checks

- [OpenWhispr custom dictionary documentation](https://docs.openwhispr.com/help/customise/custom-dictionary): vocabulary hints, auto-learning and limitations.
- [OpenWhispr privacy policy](https://feedback.openwhispr.com/privacy): correction monitoring window.
- [Groq speech-to-text documentation](https://console.groq.com/docs/speech-to-text): model choices and vocabulary prompts.
- [Groq GPT-OSS 120B documentation](https://console.groq.com/docs/model/openai/gpt-oss-120b): text model used by cleanup.

Run `npm.cmd run check` and `npm.cmd test` from the repository root; `voice-dictionary-projects.test.js` covers migration, scoping, ranking, learning and the scanner.
Run `node ai-chat-panel/test/voice-dictionary-settings.mjs` for the Settings list (per-project lists, sharing, suggestions, scan all) and `node ai-chat-panel/test/render.mjs voice` for a picture of it.
Run `node ai-chat-panel/test/voice-dictionary.mjs` for the actual chat webview's
countdown, trash cancellation, hidden-window pause, retry, stale-response and
narrow-layout checks in Edge.
The browser check simulates host replies; dictionary tests use temporary files.
It does not call Groq or any agent CLI. Reload the IDE to load extension-host changes.
