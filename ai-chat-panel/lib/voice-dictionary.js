'use strict';

// Clanker's own voice dictionary: spellings Whisper should favour, as `{ terms: [{ term, enabled, addedAt, source?, uses?,
// lastUsedAt?, usedIn? }], ignored? }` in the session directory, plus OpenWhispr's custom words (read-only, merged per
// recording, never copied in). People edit it in Settings > Voice and an AI may edit the file directly, so reading is
// forgiving (a bare string is a term, junk is dropped).
//
// The file is a long memory: it keeps thousands of words and never forgets one on its own. Only a few dozen fit into a
// transcription request, so `vocabulary` ranks every word per recording (see `score`) and sends the best. Nobody picks
// favourites; `uses`, `lastUsedAt` and `usedIn` (uses per project id) are bookkeeping that `recordUse` keeps current.

const fs = require('node:fs');
const path = require('node:path');

const MAX_TERM_LENGTH = 60;
const LIMITS = Object.freeze({
  entries: 5000,      // words kept in the file
  scanned: 1500,      // of those, how many project scans may own, so a scan never crowds out hand-picked words
  scanBatch: 60,      // words one scan adds
  promptTerms: 40,    // words in Whisper's `prompt` (it holds ~224 tokens)
  promptChars: 480,   // identifiers cost several tokens each, so the prompt is also capped by length
  cleanupTerms: 150,  // words handed to the cleanup model's prompt
});
const SOURCES = ['manual', 'learned', 'scan', 'ai'];
const DAY_MS = 86400000;
const MAX_PROJECT_STATS = 12; // projects remembered per word
const key = (term) => String(term).trim().toLowerCase();

const clean = (raw) => {
  const entry = typeof raw === 'string' ? { term: raw } : raw;
  const term = String(entry?.term ?? '').replace(/\s+/g, ' ').trim();
  if (!term || term.length > MAX_TERM_LENGTH) return null;
  return { ...entry, term, enabled: entry.enabled !== false, addedAt: Number(entry.addedAt) || 0 };
};

function load(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const seen = new Set();
    const terms = (Array.isArray(parsed.terms) ? parsed.terms : []).map(clean)
      .filter((entry) => entry && !seen.has(key(entry.term)) && seen.add(key(entry.term)));
    return { ...parsed, terms, ignored: Array.isArray(parsed.ignored) ? parsed.ignored.map(key) : [] };
  } catch {
    return { terms: [], ignored: [] }; // a missing or half-written file never blocks dictation
  }
}

function save(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file); // a reader (or the watcher) never sees half a file
}

const isScan = (entry) => entry.source === 'scan';
const find = (data, term) => data.terms.find((entry) => key(entry.term) === key(term));
const checkTerm = (rawTerm) => {
  const term = String(rawTerm || '').replace(/\s+/g, ' ').trim();
  if (!term) throw new Error('term must not be empty');
  if (term.length > MAX_TERM_LENGTH) throw new Error(`term must be ${MAX_TERM_LENGTH} characters or fewer`);
  return term;
};

const listTerms = ({ dictionaryFile }) => load(dictionaryFile).terms;
const listEnabledTerms = (paths) => listTerms(paths).filter((entry) => entry.enabled).map((entry) => entry.term);

function addTerm({ dictionaryFile }, rawTerm, { replaceSpelling = false, source = 'manual' } = {}) {
  const term = checkTerm(rawTerm);
  const data = load(dictionaryFile);
  const existing = find(data, term);
  if (existing) {
    if (replaceSpelling) existing.term = term;
    existing.enabled = true;
    if (isScan(existing) && source !== 'scan') delete existing.source; // a word the user chose is theirs now
  } else {
    if (data.terms.length >= LIMITS.entries) throw new Error(`The dictionary is full (${LIMITS.entries} words). Delete some first.`);
    data.terms.push({ term, enabled: true, addedAt: Date.now(), ...(source === 'manual' ? {} : { source }) });
    data.ignored = data.ignored.filter((ignored) => ignored !== key(term));
  }
  save(dictionaryFile, data);
}

/** Rename and/or switch a word on or off. `next` may differ from `term` only in spelling or become another word. */
function updateTerm({ dictionaryFile }, term, { next = term, enabled } = {}) {
  const data = load(dictionaryFile);
  const entry = find(data, term);
  if (!entry) throw new Error('That word is no longer in the dictionary.');
  const renamed = checkTerm(next);
  const clash = find(data, renamed);
  if (clash && clash !== entry) throw new Error(`“${clash.term}” is already in the dictionary.`);
  if (renamed !== entry.term) { entry.term = renamed; if (isScan(entry)) delete entry.source; }
  if (typeof enabled === 'boolean') entry.enabled = enabled;
  save(dictionaryFile, data);
}

/** A deleted scanned word is remembered, so scanning the same project again does not bring it back. */
function removeTerm({ dictionaryFile }, term) {
  const data = load(dictionaryFile);
  const entry = find(data, term);
  if (!entry) return;
  data.terms = data.terms.filter((other) => other !== entry);
  if (isScan(entry) && !data.ignored.includes(key(term))) data.ignored.push(key(term));
  save(dictionaryFile, data);
}

function removeScanned({ dictionaryFile }) {
  const data = load(dictionaryFile);
  const removed = data.terms.filter(isScan).length;
  data.terms = data.terms.filter((entry) => !isScan(entry));
  if (removed) save(dictionaryFile, data);
  return removed;
}

/**
 * Bulk add for a project scan. Keeps to the limits (a batch, the scanned share, the whole file) and never overwrites a
 * word that is already there. Returns how many went in and how many were left out.
 */
function addScanned({ dictionaryFile }, terms, project = '') {
  const data = load(dictionaryFile);
  const room = Math.min(LIMITS.scanBatch, LIMITS.scanned - data.terms.filter(isScan).length, LIMITS.entries - data.terms.length);
  const ignored = new Set(data.ignored);
  const taken = new Set(data.terms.map((entry) => key(entry.term)));
  const fresh = [];
  for (const raw of terms) {
    const term = String(raw || '').trim();
    if (!term || term.length > MAX_TERM_LENGTH || taken.has(key(term)) || ignored.has(key(term))) continue;
    taken.add(key(term));
    fresh.push(term);
  }
  const added = fresh.slice(0, Math.max(0, room));
  const now = Date.now();
  data.terms.push(...added.map((term) => ({ term, enabled: true, addedAt: now, source: 'scan', ...(project ? { project } : {}) })));
  if (added.length) save(dictionaryFile, data);
  return { added: added.length, skipped: fresh.length - added.length, full: room <= 0 || fresh.length > added.length };
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

const BASE_SCORE = { learned: 3, manual: 2, openwhispr: 2, ai: 1.5, scan: 0 }; // a corrected word is one Whisper got wrong
const JITTER = 1.5; // random lift per recording: words with no history take turns instead of one fixed list winning forever

/**
 * How useful a word is for the next recording. Recent and frequent use count, more so in the project being worked on;
 * a scanned word is lifted when it came from that project; a brand-new word gets a short head start. The random lift is
 * what keeps a thousand rarely-used words rotating through the few slots without anyone managing them.
 */
function score(entry, { projectId = '', projectName = '', now = Date.now() } = {}, random = Math.random) {
  let points = BASE_SCORE[entry.source] ?? BASE_SCORE.manual;
  if (entry.lastUsedAt) points += 3 * 0.5 ** (Math.max(0, now - entry.lastUsedAt) / (30 * DAY_MS));
  points += Math.min(2, 0.5 * Math.log2(1 + (entry.uses || 0)));
  const here = projectId && entry.usedIn?.[projectId];
  if (here) points += 1.5 + Math.min(1.5, 0.5 * Math.log2(1 + here));
  if (isScan(entry) && projectName && key(entry.project || '') === key(projectName)) points += 3;
  if (entry.addedAt && now - entry.addedAt < 14 * DAY_MS) points += 1;
  return points + random() * JITTER;
}

/**
 * Every term to bias the models with, most useful first for this project and moment. Words people chose, OpenWhispr's and
 * scanned ones compete on the same scale. `context` is `{ projectId, projectName, now, random }`.
 */
async function vocabulary(paths, openWhisprPath, context = {}) {
  const candidates = listTerms(paths).filter((entry) => entry.enabled);
  const known = new Set(candidates.map((entry) => key(entry.term)));
  for (const term of await readOpenWhisprTerms(openWhisprPath)) if (!known.has(key(term)) && known.add(key(term))) candidates.push({ term, source: 'openwhispr' });
  return candidates.map((entry) => ({ term: entry.term, points: score(entry, context, context.random) }))
    .sort((a, b) => b.points - a.points).map((entry) => entry.term);
}

/** The enabled words that appear in `text`, matched the way people type them: whole words, any case. */
function mentionedTerms(entries, text) {
  const haystack = String(text || '').toLowerCase();
  if (!haystack.trim()) return [];
  const words = new Set(haystack.split(/[^\p{L}\p{N}_#+.'-]+/u).map((word) => word.replace(/^[.'-]+|[.'-]+$/g, '')).filter(Boolean));
  return entries.filter((entry) => {
    const wanted = key(entry.term);
    return /\s/.test(wanted) ? haystack.includes(wanted) : words.has(wanted);
  });
}

/** Notes that the words in `text` were just dictated or sent, so they rank higher next time, most of all in this project. */
function recordUse({ dictionaryFile }, text, { projectId = '', now = Date.now() } = {}) {
  const data = load(dictionaryFile);
  const hits = mentionedTerms(data.terms.filter((entry) => entry.enabled), text);
  if (!hits.length) return 0;
  for (const entry of hits) {
    entry.uses = (entry.uses || 0) + 1;
    entry.lastUsedAt = now;
    if (!projectId) continue;
    entry.usedIn = { ...entry.usedIn, [projectId]: (entry.usedIn?.[projectId] || 0) + 1 };
    const projects = Object.entries(entry.usedIn);
    if (projects.length > MAX_PROJECT_STATS) entry.usedIn = Object.fromEntries(projects.sort((a, b) => b[1] - a[1]).slice(0, MAX_PROJECT_STATS));
  }
  save(dictionaryFile, data);
  return hits.length;
}

/** The words that fit Whisper's `prompt`: leading ones, up to the term and character caps. */
function promptTerms(terms) {
  const picked = [];
  let chars = 0;
  for (const term of terms) {
    if (picked.length >= LIMITS.promptTerms || chars + term.length + 2 > LIMITS.promptChars) break;
    picked.push(term);
    chars += term.length + 2;
  }
  return picked;
}

/** What Settings shows: how many words there are. Which of them reach a model is decided per recording and not shown. */
function usage(paths) {
  const terms = listTerms(paths);
  return { total: terms.length, enabled: terms.filter((entry) => entry.enabled).length, scanned: terms.filter(isScan).length, limits: { entries: LIMITS.entries } };
}

module.exports = {
  LIMITS, SOURCES, MAX_TERM_LENGTH, listTerms, listEnabledTerms, addTerm, updateTerm, removeTerm, removeScanned, addScanned,
  readOpenWhisprTerms, vocabulary, promptTerms, mentionedTerms, recordUse, score, usage,
};
