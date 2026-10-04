'use strict';

// Clanker's own voice dictionary: spellings Whisper should favour, as `{ terms: [{ term, enabled, addedAt }] }` in
// the session directory, plus OpenWhispr's custom words (read-only, merged per recording, never copied in).

const fs = require('node:fs');
const path = require('node:path');

const MAX_TERM_LENGTH = 60;
const key = (term) => String(term).trim().toLowerCase();

function load(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ...parsed, terms: Array.isArray(parsed.terms) ? parsed.terms : [] };
  } catch {
    return { terms: [] }; // a missing or half-written file never blocks dictation
  }
}

function listEnabledTerms({ dictionaryFile }) {
  return load(dictionaryFile).terms.filter((entry) => entry.enabled).map((entry) => entry.term);
}

function addTerm({ dictionaryFile }, rawTerm) {
  const term = String(rawTerm || '').trim();
  if (!term) throw new Error('term must not be empty');
  if (term.length > MAX_TERM_LENGTH) throw new Error(`term must be ${MAX_TERM_LENGTH} characters or fewer`);
  const data = load(dictionaryFile);
  const existing = data.terms.find((entry) => key(entry.term) === key(term));
  if (existing) existing.enabled = true;
  else data.terms.push({ term, enabled: true, addedAt: Date.now() });
  fs.mkdirSync(path.dirname(dictionaryFile), { recursive: true });
  fs.writeFileSync(dictionaryFile, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

const openWhisprDatabasePath = () => process.env.OPENWHISPR_DB_PATH || path.join(process.env.APPDATA || '', 'open-whispr', 'transcriptions.db');

/** OpenWhispr's words through Node's built-in SQLite, opened read-only so a running dictation app is never touched. */
async function readOpenWhisprTerms(databasePath = openWhisprDatabasePath()) {
  if (!databasePath || !fs.existsSync(databasePath)) return [];
  let db;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(databasePath, { readOnly: true });
    return db.prepare('SELECT word FROM custom_dictionary WHERE word IS NOT NULL ORDER BY created_at DESC').all()
      .map((row) => String(row.word || '').trim())
      .filter((term) => term && term.length <= MAX_TERM_LENGTH);
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

/** Every term to bias Whisper with: the dictionary's enabled ones first, then OpenWhispr's, each spelling once. */
async function vocabulary(paths, openWhisprPath) {
  const seen = new Set();
  return [...listEnabledTerms(paths), ...await readOpenWhisprTerms(openWhisprPath)].filter((term) => !seen.has(key(term)) && seen.add(key(term)));
}

module.exports = { listEnabledTerms, addTerm, readOpenWhisprTerms, vocabulary };
