'use strict';

// Clanker's own voice dictionary: spellings Whisper should favour, kept per project, plus a small shared layer and
// OpenWhispr's custom words (read-only, merged per recording, never copied in). The file in the session directory is
//   { version: 2, terms: [{ term, enabled, addedAt, projectId?, source?, weight?, uses?, lastUsedAt?, usedIn? }],
//     ignored: [...], pending: { ... } }
// A word with a `projectId` belongs to that project's dictionary and is only offered while dictating in it. A word
// without one is shared: it is offered everywhere, but only up to `LIMITS.sharedShare` of the slots, so one busy
// project cannot crowd out another's vocabulary. People edit it in Settings > Voice and an AI may edit the file
// directly, so reading is forgiving (a bare string is a shared word, junk is dropped).
//
// Everything here is deterministic: the same file and the same project give the same words in the same order, and
// nothing calls a model. Only a few dozen words fit into a transcription request, so `vocabulary` ranks the project's
// words and the shared ones per recording (see `score`) and sends the best. Nobody picks favourites: `uses`,
// `lastUsedAt` and `usedIn` are bookkeeping that `recordUse` keeps current, and it also notices unfamiliar terms you
// keep typing (`pending`) and words that turned out useful in several projects, and offers them as suggestions.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { looksLikeTerm } = require('./voice-scan');

const MAX_TERM_LENGTH = 60;
const VERSION = 2;
const LIMITS = Object.freeze({
  entries: 5000,          // words kept in the file
  scanned: 1500,          // of those, how many project scans may own, so a scan never crowds out hand-picked words
  scannedPerProject: 150, // and how many one project's scan may own
  perScan: 80,            // words one scan adds
  promptTerms: 40,        // words in Whisper's `prompt` (it holds ~224 tokens)
  promptChars: 480,       // identifiers cost several tokens each, so the prompt is also capped by length
  cleanupTerms: 150,      // words handed to the cleanup model's prompt
  sharedShare: 0.25,      // the largest part of any prefix of the ranked list that shared words may take
  suggestAfter: 3,        // separate messages an unfamiliar term must appear in before it is suggested
  pending: 200,           // unfamiliar terms being counted
});
const SOURCES = ['manual', 'learned', 'scan', 'ai'];
const DAY_MS = 86400000;
const MAX_PROJECT_STATS = 12; // projects remembered per word
const key = (term) => String(term).trim().toLowerCase();
const scopeKey = (projectId, term) => `${projectId || ''}|${key(term)}`;
const ignoredKey = (projectId, term) => (projectId ? `${projectId}|${key(term)}` : key(term));

const clean = (raw) => {
  const entry = typeof raw === 'string' ? { term: raw } : raw;
  const term = String(entry?.term ?? '').replace(/\s+/g, ' ').trim();
  if (!term || term.length > MAX_TERM_LENGTH) return null;
  const { projectId, ...rest } = entry;
  return { ...rest, term, ...(typeof projectId === 'string' && projectId ? { projectId } : {}), enabled: entry.enabled !== false, addedAt: Number(entry.addedAt) || 0 };
};

/** Version 1 had one list for everything. A scanned word goes to the project it was scanned from, a word only ever used in one project goes there; the rest stays shared, as it always was. */
function migrate(data, projects) {
  const ids = new Set(projects.map((project) => project.id));
  const byName = new Map();
  for (const project of projects) if (!byName.has(key(project.name))) byName.set(key(project.name), project.id);
  for (const entry of data.terms) {
    if (entry.projectId) continue;
    if (entry.source === 'scan') {
      const id = byName.get(key(entry.project || ''));
      if (id) entry.projectId = id;
      continue;
    }
    const used = Object.entries(entry.usedIn || {}).filter(([, uses]) => uses > 0);
    if (used.length === 1 && used[0][1] >= 3 && ids.has(used[0][0])) entry.projectId = used[0][0];
  }
  data.version = VERSION;
}

function load(paths) {
  const file = paths.dictionaryFile;
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { version: VERSION, terms: [], ignored: [], pending: {} }; } // a missing or half-written file never blocks dictation
  const seen = new Set();
  const terms = (Array.isArray(parsed?.terms) ? parsed.terms : []).map(clean)
    .filter((entry) => entry && !seen.has(scopeKey(entry.projectId, entry.term)) && seen.add(scopeKey(entry.projectId, entry.term)));
  const data = {
    ...parsed, terms,
    ignored: Array.isArray(parsed.ignored) ? parsed.ignored.map(key) : [],
    pending: parsed.pending && typeof parsed.pending === 'object' && !Array.isArray(parsed.pending) ? parsed.pending : {},
  };
  if ((Number(parsed.version) || 1) < VERSION) {
    migrate(data, typeof paths.projects === 'function' ? safeProjects(paths.projects) : []);
    try { // keep the old file once, then write the new shape
      const backup = `${file}.v1.bak`;
      if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
      save(file, data);
    } catch { /* read-only storage: the migrated words still work in memory */ }
  }
  return data;
}

const safeProjects = (list) => { try { return (list() || []).filter((project) => project?.id); } catch { return []; } };

function save(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ ...data, version: VERSION }, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file); // a reader (or the watcher) never sees half a file
}

const isScan = (entry) => entry.source === 'scan';
const find = (data, term, projectId = '') => data.terms.find((entry) => key(entry.term) === key(term) && (entry.projectId || '') === (projectId || ''));
const checkTerm = (rawTerm) => {
  const term = String(rawTerm || '').replace(/\s+/g, ' ').trim();
  if (!term) throw new Error('term must not be empty');
  if (term.length > MAX_TERM_LENGTH) throw new Error(`term must be ${MAX_TERM_LENGTH} characters or fewer`);
  return term;
};
const userOwns = (entry) => { if (isScan(entry)) { delete entry.source; delete entry.weight; } }; // a word the user chose is theirs now

const listTerms = (paths) => load(paths).terms;
/** The enabled words a recording in `projectId` may use: that project's own and the shared ones. Without a project, the shared ones. */
const listEnabledTerms = (paths, projectId = '') => listTerms(paths).filter((entry) => entry.enabled && (!entry.projectId || entry.projectId === projectId)).map((entry) => entry.term);

function addTerm(paths, rawTerm, { replaceSpelling = false, source = 'manual', projectId = '', weight } = {}) {
  const term = checkTerm(rawTerm);
  const data = load(paths);
  const existing = find(data, term, projectId);
  if (existing) {
    if (replaceSpelling) existing.term = term;
    existing.enabled = true;
    if (source !== 'scan') userOwns(existing);
  } else {
    if (data.terms.length >= LIMITS.entries) throw new Error(`The dictionary is full (${LIMITS.entries} words). Delete some first.`);
    data.terms.push({ term, enabled: true, addedAt: Date.now(), ...(projectId ? { projectId } : {}), ...(source === 'manual' ? {} : { source }), ...(weight ? { weight } : {}) });
    data.ignored = data.ignored.filter((ignored) => ignored !== ignoredKey(projectId, term));
  }
  delete data.pending[scopeKey(projectId, term)];
  save(paths.dictionaryFile, data);
}

/** Rename and/or switch a word on or off. `next` may differ from `term` only in spelling or become another word. */
function updateTerm(paths, term, { next = term, enabled, projectId = '' } = {}) {
  const data = load(paths);
  const entry = find(data, term, projectId);
  if (!entry) throw new Error('That word is no longer in the dictionary.');
  const renamed = checkTerm(next);
  const clash = find(data, renamed, projectId);
  if (clash && clash !== entry) throw new Error(`“${clash.term}” is already in the dictionary.`);
  if (renamed !== entry.term) { entry.term = renamed; userOwns(entry); }
  if (typeof enabled === 'boolean') entry.enabled = enabled;
  save(paths.dictionaryFile, data);
}

/** A deleted scanned word is remembered, so scanning the same project again does not bring it back. */
function removeTerm(paths, term, { projectId = '' } = {}) {
  const data = load(paths);
  const entry = find(data, term, projectId);
  if (!entry) return;
  data.terms = data.terms.filter((other) => other !== entry);
  if (isScan(entry) && !data.ignored.includes(ignoredKey(projectId, term))) data.ignored.push(ignoredKey(projectId, term));
  save(paths.dictionaryFile, data);
}

/** Moves a word between dictionaries ('' is the shared one). A word the target already has absorbs its use history. */
function moveTerm(paths, term, { from = '', to = '' } = {}) {
  const data = load(paths);
  const entry = find(data, term, from);
  if (!entry) throw new Error('That word is no longer in the dictionary.');
  if ((from || '') === (to || '')) return;
  const clash = find(data, term, to);
  if (clash) {
    clash.enabled = clash.enabled || entry.enabled;
    clash.uses = (clash.uses || 0) + (entry.uses || 0);
    clash.lastUsedAt = Math.max(clash.lastUsedAt || 0, entry.lastUsedAt || 0) || undefined;
    if (isScan(clash) && !isScan(entry)) userOwns(clash);
    data.terms = data.terms.filter((other) => other !== entry);
  } else if (to) entry.projectId = to;
  else delete entry.projectId;
  delete entry.shareDismissed;
  save(paths.dictionaryFile, data);
}

/** Removes scanned words: one project's, or (without a project) everyone's. */
function removeScanned(paths, { projectId } = {}) {
  const data = load(paths);
  const doomed = (entry) => isScan(entry) && (projectId === undefined || (entry.projectId || '') === projectId);
  const removed = data.terms.filter(doomed).length;
  data.terms = data.terms.filter((entry) => !doomed(entry));
  if (removed) save(paths.dictionaryFile, data);
  return removed;
}

/**
 * Brings one project's scanned words up to date with a fresh scan (`entries` from `scanProject`, best first). Words the
 * scan still finds are re-weighted, words it no longer finds go unless they were used, and new ones are added within the
 * limits. Words people chose, and ones they deleted from a scan, are never touched.
 */
function applyScan(paths, projectId, entries, { projectName = '', partial = false } = {}) {
  if (!projectId) throw new Error('A scan belongs to a project.');
  const data = load(paths);
  const ignored = new Set(data.ignored);
  const fresh = new Map();
  for (const raw of entries) {
    const term = String(raw?.term ?? raw ?? '').replace(/\s+/g, ' ').trim();
    if (!term || term.length > MAX_TERM_LENGTH || fresh.has(key(term)) || ignored.has(ignoredKey(projectId, term)) || ignored.has(key(term))) continue;
    fresh.set(key(term), { term, weight: Number(raw?.weight) || 0.6 });
  }
  const result = { found: fresh.size, added: 0, updated: 0, removed: 0, kept: 0, full: false };
  const owned = new Set(data.terms.filter((entry) => (entry.projectId || '') === projectId && !isScan(entry)).map((entry) => key(entry.term)));
  data.terms = data.terms.filter((entry) => {
    if (!isScan(entry) || entry.projectId !== projectId) return true;
    const next = fresh.get(key(entry.term));
    if (next) { entry.weight = next.weight; entry.project = projectName || entry.project; fresh.delete(key(entry.term)); result.updated++; }
    else if (partial || entry.uses) result.kept++;
    else { result.removed++; return false; }
    return true;
  });
  const scannedHere = data.terms.filter((entry) => isScan(entry) && (entry.projectId || '') === projectId).length;
  const room = Math.max(0, Math.min(LIMITS.perScan, LIMITS.scannedPerProject - scannedHere, LIMITS.scanned - data.terms.filter(isScan).length, LIMITS.entries - data.terms.length));
  const candidates = [...fresh.values()].filter((item) => !owned.has(key(item.term)));
  const now = Date.now();
  const added = candidates.slice(0, room);
  data.terms.push(...added.map((item) => ({ term: item.term, enabled: true, addedAt: now, source: 'scan', projectId, weight: item.weight, ...(projectName ? { project: projectName } : {}) })));
  result.added = added.length;
  result.full = candidates.length > added.length;
  if (result.added || result.updated || result.removed) save(paths.dictionaryFile, data);
  return result;
}

const openWhisprDatabasePath = () => process.env.OPENWHISPR_DB_PATH || path.join(process.platform === 'win32' ? process.env.APPDATA || '' : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'open-whispr', 'transcriptions.db');

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

const BASE_SCORE = { learned: 3, manual: 2.5, openwhispr: 2, ai: 1.5 }; // a corrected word is one Whisper got wrong; a scan word brings its own weight (0.6 to 3)

/**
 * How useful a word is for the next recording. Recent and frequent use count, more so in the project being worked on;
 * a scanned word starts at the weight its scan gave it (how widely the project uses it); a brand-new word gets a short
 * head start. There is no randomness: what you use rises, what you never use stays where the scan put it.
 */
function score(entry, { projectId = '', now = Date.now() } = {}) {
  let points = isScan(entry) ? Number(entry.weight ?? 0.5) : (BASE_SCORE[entry.source] ?? BASE_SCORE.manual);
  if (entry.lastUsedAt) points += 3 * 0.5 ** (Math.max(0, now - entry.lastUsedAt) / (30 * DAY_MS));
  points += Math.min(2, 0.5 * Math.log2(1 + (entry.uses || 0)));
  const here = projectId && entry.usedIn?.[projectId];
  if (here) points += 1.5 + Math.min(1.5, 0.5 * Math.log2(1 + here));
  if (entry.addedAt && now - entry.addedAt < 14 * DAY_MS) points += 1;
  return points;
}

const byPoints = (a, b) => b.points - a.points || (key(a.term) < key(b.term) ? -1 : key(a.term) > key(b.term) ? 1 : 0);

/** Interleaves the project's ranked words with the shared ones; shared words never take more than their share of any prefix. */
function mergeCapped(own, shared, share = LIMITS.sharedShare) {
  const merged = [];
  let o = 0, s = 0;
  while (o < own.length || s < shared.length) {
    const sharedAllowed = s < shared.length && (o >= own.length || s + 1 <= Math.ceil(share * (merged.length + 1)));
    if (sharedAllowed && (o >= own.length || shared[s].points > own[o].points)) merged.push(shared[s++]);
    else merged.push(own[o++]);
  }
  return merged.map((item) => item.term);
}

/**
 * Every term to bias the models with, most useful first for this project and moment: the project's own words, then the
 * shared ones and OpenWhispr's within their share. `context` is `{ projectId, now }`; without a project only shared words
 * count. Another project's words are never included.
 */
async function vocabulary(paths, openWhisprPath, context = {}) {
  const { projectId = '' } = context;
  const enabled = listTerms(paths).filter((entry) => entry.enabled);
  const own = enabled.filter((entry) => projectId && entry.projectId === projectId);
  const shared = enabled.filter((entry) => !entry.projectId);
  const taken = new Set(own.map((entry) => key(entry.term))); // the project's own spelling wins over a shared one
  const sharedKnown = new Set(shared.map((entry) => key(entry.term)));
  const outside = [];
  for (const term of await readOpenWhisprTerms(openWhisprPath)) if (!sharedKnown.has(key(term)) && sharedKnown.add(key(term))) outside.push({ term, source: 'openwhispr' });
  const rank = (entries) => entries.map((entry) => ({ term: entry.term, points: score(entry, context) })).sort(byPoints);
  return mergeCapped(rank(own), rank([...shared, ...outside].filter((entry) => !taken.has(key(entry.term)))));
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

const MAX_TEXT = 6000;
/** What you typed or said, without pasted code, links and paths: those show what a file contains, not what you mean. */
const prose = (text) => String(text || '').replace(/```[\s\S]*?(?:```|$)/g, ' ').replace(/https?:\/\/\S+/g, ' ').replace(/(?:[A-Za-z]:)?[\\/][\w.\\/-]{6,}/g, ' ').slice(0, MAX_TEXT);

/**
 * Notes that the words in `text` were just sent from `projectId`, so they rank higher next time, most of all there.
 * Each word counts once per message. A word that belongs to another project's dictionary only records the cross-use (it
 * may be worth sharing); an unfamiliar term that looks like a name is counted towards a suggestion. Returns how many of
 * this project's words (or shared ones) were used.
 */
function recordUse(paths, text, { projectId = '', now = Date.now() } = {}) {
  const data = load(paths);
  const body = prose(text);
  const enabled = data.terms.filter((entry) => entry.enabled);
  const hits = mentionedTerms(enabled, body);
  let changed = false;
  let usedHere = 0;
  for (const entry of hits) {
    const inScope = !entry.projectId || entry.projectId === projectId;
    if (inScope) { entry.uses = (entry.uses || 0) + 1; entry.lastUsedAt = now; usedHere++; }
    if (projectId) {
      entry.usedIn = { ...entry.usedIn, [projectId]: (entry.usedIn?.[projectId] || 0) + 1 };
      const projects = Object.entries(entry.usedIn);
      if (projects.length > MAX_PROJECT_STATS) entry.usedIn = Object.fromEntries(projects.sort((a, b) => b[1] - a[1]).slice(0, MAX_PROJECT_STATS));
    }
    changed = true;
  }
  if (projectId && noteUnfamiliar(data, body, projectId, now, new Set(hits.map((entry) => key(entry.term))))) changed = true;
  if (changed) save(paths.dictionaryFile, data);
  return usedHere;
}

function noteUnfamiliar(data, body, projectId, now, mentioned) {
  const known = new Set(data.terms.map((entry) => key(entry.term)));
  const ignored = new Set(data.ignored);
  let changed = false;
  const tokens = [...new Set(body.match(/[A-Za-z][A-Za-z0-9]{2,39}/g) || [])].filter(looksLikeTerm).slice(0, 25);
  for (const token of tokens) {
    if (known.has(key(token)) || mentioned.has(key(token)) || ignored.has(ignoredKey(projectId, token)) || ignored.has(key(token))) continue;
    const id = scopeKey(projectId, token);
    const seen = data.pending[id] || { term: token, projectId, n: 0 };
    data.pending[id] = { ...seen, n: seen.n + 1, last: now };
    changed = true;
  }
  const ids = Object.keys(data.pending);
  for (const id of ids) { // a term seen once or twice and then never again is a one-off
    const item = data.pending[id];
    if (!item || typeof item !== 'object' || !item.term || (item.n < LIMITS.suggestAfter && now - (item.last || 0) > 45 * DAY_MS)) { delete data.pending[id]; changed = true; }
  }
  const left = Object.entries(data.pending);
  if (left.length > LIMITS.pending) {
    for (const [id] of left.sort((a, b) => a[1].n - b[1].n || (a[1].last || 0) - (b[1].last || 0)).slice(0, left.length - LIMITS.pending)) delete data.pending[id];
    changed = true;
  }
  return changed;
}

/**
 * What Clanker proposes, never applies on its own: `add` is unfamiliar terms you typed in several messages in a project,
 * `share` is a project word that was also used in other projects.
 */
function suggestions(paths) {
  const data = load(paths);
  const add = Object.values(data.pending).filter((item) => item.n >= LIMITS.suggestAfter && item.projectId)
    .sort((a, b) => b.n - a.n || key(a.term).localeCompare(key(b.term))).slice(0, 8)
    .map((item) => ({ term: item.term, projectId: item.projectId, count: item.n }));
  const share = data.terms.filter((entry) => entry.enabled && entry.projectId && !entry.shareDismissed)
    .map((entry) => ({ entry, projects: Object.entries(entry.usedIn || {}).filter(([, uses]) => uses > 0) }))
    .filter(({ projects }) => projects.length >= 2 && projects.reduce((sum, [, uses]) => sum + uses, 0) >= 3)
    .sort((a, b) => b.projects.length - a.projects.length || key(a.entry.term).localeCompare(key(b.entry.term))).slice(0, 8)
    .map(({ entry, projects }) => ({ term: entry.term, projectId: entry.projectId, projects: projects.length }));
  return { add, share };
}

/** Takes a suggestion: `add` puts the term in that project's dictionary, `share` moves a project word to the shared one. */
function acceptSuggestion(paths, kind, term, projectId) {
  if (kind === 'share') return moveTerm(paths, term, { from: projectId, to: '' });
  addTerm(paths, term, { source: 'learned', projectId });
}

/** Declines a suggestion for good. */
function dismissSuggestion(paths, kind, term, projectId) {
  const data = load(paths);
  if (kind === 'share') {
    const entry = find(data, term, projectId);
    if (entry) entry.shareDismissed = true;
  } else {
    delete data.pending[scopeKey(projectId, term)];
    if (!data.ignored.includes(ignoredKey(projectId, term))) data.ignored.push(ignoredKey(projectId, term));
  }
  save(paths.dictionaryFile, data);
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

/** What Settings shows: how many words there are, and how they split. Which of them reach a model is decided per recording and not shown. */
function usage(paths) {
  const terms = listTerms(paths);
  const byProject = {};
  for (const entry of terms) if (entry.projectId) byProject[entry.projectId] = (byProject[entry.projectId] || 0) + 1;
  return { total: terms.length, enabled: terms.filter((entry) => entry.enabled).length, scanned: terms.filter(isScan).length, shared: terms.filter((entry) => !entry.projectId).length, byProject, limits: { entries: LIMITS.entries } };
}

module.exports = {
  LIMITS, SOURCES, MAX_TERM_LENGTH, listTerms, listEnabledTerms, addTerm, updateTerm, removeTerm, moveTerm, removeScanned, applyScan,
  readOpenWhisprTerms, vocabulary, promptTerms, mentionedTerms, recordUse, suggestions, acceptSuggestion, dismissSuggestion, score, usage,
};
