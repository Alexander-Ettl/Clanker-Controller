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

The dictionary is user-wide and stored as `voice-dictionary.json` in Clanker's
extension session storage. It is not written into a project. Existing OpenWhispr
dictionary entries are also read when available, without modifying its database.
Dictionary hints increase recognition likelihood; they do not guarantee exact
replacement.

### Managing the dictionary

**Settings → Voice → Dictionary** lists every word. Search it, add a word, double-click or use the pencil to
rename one, switch a word off without losing it, or delete it. **Scan a project** reads a registered project (or any
folder, via *Choose folder…*, for a new project) and adds the technical words it finds: the project name, package
names from `package.json`, and class, function and mixed-case identifiers it declares or reuses across files. The
scan is local and read-only, skips dependency, build and secret files, and never follows links. **Edit with AI**
puts a prompt in the composer that tells a chat model the file format and limits; the file is watched, so the
list updates when the model saves it. Words from a scan are tagged *scan* and can be removed together.

### Limits

| What | Limit |
| --- | --- |
| Words in the file | 5,000 (a hand edit beyond that still works: only the limits below reach the models) |
| Words from scans | 1,500 in total, 60 per scan; a word you delete is not re-added by the next scan |
| Whisper `prompt` | the 40 best-ranked enabled words and at most 480 characters (it holds ~224 tokens) |
| Cleanup prompt | the 150 best-ranked enabled words |
| One word | 60 characters |

Which words fill those slots is decided for every recording, not by you. Each enabled word (and OpenWhispr's) gets a
score: a base by origin (a corrected word 3, hand-added or OpenWhispr 2, AI-added 1.5, scanned 0), a bonus for recent use
(fading over about a month) and for how often it was used, a bonus when it was used in the chat's project (or, for a
scanned word, came from that project), a short head start for a new word, and a random lift of up to 1.5 so words with
no history take turns. Dictating or sending a message that contains a word records the use (`uses`, `lastUsedAt`,
`usedIn` per project id in the file; leave those fields alone when editing by hand). Settings shows only the number of
words, not which ones are sent. A scan reads at most 1,200 files, 256 KB per file, 6 MB in total and
5 seconds, then stops and says so.

## References and checks

- [OpenWhispr custom dictionary documentation](https://docs.openwhispr.com/help/customise/custom-dictionary): vocabulary hints, auto-learning and limitations.
- [OpenWhispr privacy policy](https://feedback.openwhispr.com/privacy): correction monitoring window.
- [Groq speech-to-text documentation](https://console.groq.com/docs/speech-to-text): model choices and vocabulary prompts.
- [Groq GPT-OSS 120B documentation](https://console.groq.com/docs/model/openai/gpt-oss-120b): text model used by cleanup.

Run `npm.cmd run check` and `npm.cmd test` from the repository root.
Run `node ai-chat-panel/test/voice-dictionary-settings.mjs` for the Settings list and `node ai-chat-panel/test/render.mjs voice` for a picture of it.
Run `node ai-chat-panel/test/voice-dictionary.mjs` for the actual chat webview's
countdown, trash cancellation, hidden-window pause, retry, stale-response and
narrow-layout checks in Edge.
The browser check simulates host replies; dictionary tests use temporary files.
It does not call Groq or any agent CLI. Reload the IDE to load extension-host changes.
