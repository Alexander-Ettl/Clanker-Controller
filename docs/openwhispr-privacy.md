# OpenWhispr dictionary import and privacy

The Astro Content Editor can import custom vocabulary from OpenWhispr only after the author chooses **Import from OpenWhispr** in Voice Dictionary. The separate **Import new words on editor startup** option is off by default. Enabling it stores a boolean in `.astro/session/voice-dictionary.json`; it does not alter OpenWhispr's settings.

## Data read

The importer opens `%APPDATA%\open-whispr\transcriptions.db` with Node's built-in `node:sqlite` binding in read-only mode. It queries only `custom_dictionary.word` and `custom_dictionary.created_at`. It never reads transcript text, audio, model prompts, or unrelated tables, and it never writes to the database.

The editor sends candidate words and their timestamps only to its own authenticated, local dev-server endpoint. It does not return the SQLite file path, database bytes, or any other OpenWhispr record to the browser. No network request or third-party service is involved.

## Import behavior

Manual import displays new words before writing them to the editor's local JSON dictionary. Leaving the selection empty imports all displayed words; entering comma-separated words imports that subset. Existing terms are skipped case-insensitively. Startup sync follows the same deduplication rule and runs only after the author enabled it.

Imported entries live beside the editor's other local session artifacts in `.astro/session/voice-dictionary.json`. They later act only as spelling hints for the editor's existing dictation path. Delete a term in Voice Dictionary or turn off startup sync to stop future use; removing the JSON file clears all editor-held dictionary data.

If OpenWhispr is absent, its database has moved, the table is unavailable, or the installed Node runtime lacks `node:sqlite`, the editor shows an error and imports nothing.
