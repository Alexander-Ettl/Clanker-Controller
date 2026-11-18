'use strict';

// Reads a project folder for the words dictation tends to get wrong and returns the best few, most telling first.
// Deterministic, local and read-only: nothing is sent anywhere, the same folder gives the same list, and every loop is
// bounded so a huge repository costs a few seconds, not minutes.
//
// Evidence, strongest first: the project's own name and its manifests (package.json and friends), glossary entries,
// declared class/function names, folder names of the project's parts, headings and repeated Title Case phrases in the docs,
// mixed-case identifiers and acronyms, and capitalised proper nouns that the docs never write in lowercase. Words are
// ranked by how many distinct files use them, so a product name in six files beats an internal helper repeated two
// hundred times in one file.

const fs = require('node:fs');
const path = require('node:path');

const SCAN = Object.freeze({
  files: 1200,            // files read
  fileBytes: 256 * 1024,  // a larger file is generated or data, not source
  totalBytes: 6 * 1024 * 1024,
  depth: 8,
  milliseconds: 5000,
  terms: 80,              // words returned (the dictionary's own per-project limit applies on top)
  dependencies: 25,
});
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', 'vendor', 'target', 'bin', 'obj', '.venv', 'venv',
  '__pycache__', '.next', '.nuxt', '.astro', '.svelte-kit', '.cache', '.turbo', '.migration-backup', '.idea', '.vs', 'recordings', '.recordings']);
const CODE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue', '.svelte', '.astro', '.py', '.rb', '.go', '.rs', '.java', '.kt',
  '.cs', '.cpp', '.cc', '.c', '.h', '.hpp', '.php', '.swift', '.lua', '.dart', '.scala', '.sh', '.ps1', '.sql']);
const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.txt']);
const SKIP_FILES = /^(?:\.env.*|.*\.min\.[a-z]+|.*\.(?:pem|key|p12|pfx)|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i;
const GLOSSARY_FILE = /^(?:glossary|terminology|vocabulary|dictionary|terms|lexicon)\b/i;
// Folder names every project has: they say nothing about this one.
const GENERIC_DIRS = new Set(['src', 'lib', 'libs', 'docs', 'doc', 'test', 'tests', 'spec', 'specs', 'scripts', 'script', 'media', 'assets', 'static', 'public', 'config', 'configs',
  'tools', 'tool', 'utils', 'util', 'helpers', 'common', 'shared', 'core', 'app', 'apps', 'packages', 'examples', 'example', 'fixtures', 'types', 'styles', 'components',
  'pages', 'routes', 'api', 'data', 'images', 'img', 'icons', 'fonts', 'locales', 'i18n', 'tmp', 'temp', 'work', 'archive', 'resources', 'templates', 'plugins', 'server', 'client', 'web']);

// Identifiers nearly every project of a kind uses: they would fill the list in any repository and teach Whisper nothing.
const COMMON = new Set(`getelementbyid addeventlistener removeeventlistener queryselector queryselectorall createelement appendchild
  removechild textcontent innerhtml outerhtml classlist setattribute getattribute foreach settimeout cleartimeout setinterval clearinterval
  json stringify parseint parsefloat promise async await tostring hasownproperty isarray isnan undefined nullable preventdefault
  stoppropagation stopimmediatepropagation postmessage readfilesync writefilesync existssync mkdirsync readdirsync statsync unlinksync
  console log error warn debug info html css http https url uri api sdk cli gui ide json xml yaml toml csv utf ascii uuid guid
  true false null void this self super constructor prototype module exports require import default return`.split(/\s+/));
const ACRONYM_COMMON = new Set('API SDK CLI GUI IDE JSON XML YAML TOML CSV UTF HTML CSS HTTP HTTPS URL URI UUID GUID TODO FIXME NOTE README MIT GET POST PUT PATCH DELETE PASS FAIL NOT AND HEAD LOW MEDIUM HIGH NONE ERROR WARN INFO DEBUG BUG OFF THE FOR'.split(' '));
// The parts of a camelCase name that every codebase uses: a name made of nothing else (createdAt, openChat) is plumbing.
const GENERIC_PARTS = new Set(`get set is has can should will add remove delete create update read write load save start stop end begin finish open close show hide toggle enable
  disable init reset clear check validate parse format render handle on off new old next prev previous first last current active default main base item items list array map
  value values key keys name names id ids type types kind mode state status data info text string number count size length width height index path file files dir folder
  url uri src dest source target from to at by of in with for as all any none some one two args arg props prop options option opts config settings context ctx event events
  error errors message messages result results response request req res callback handler listener element elements node nodes child children parent root top left right
  bottom min max sum total time date timeout ms sec seconds minutes hours days user users view window page tab panel chat agent model project session task turn run job
  queue store cache temp tmp log debug warn use send post fetch find filter sort wait ready done loaded loading enabled disabled visible hidden selected focus click
  change input output label title button icon image color theme style class`.split(/\s+/));
const TEST_FILE = /(?:^|[\\/])(?:tests?|__tests__|specs?|e2e|fixtures?)(?:[\\/]|$)|\.(?:test|spec)\.[a-z]+$/i;
// Words that begin sentences and headings, or label things, in nearly any document.
const PROSE_COMMON = new Set(`the this that these those there then than when where while what which who why how with without from into onto about after before during
  also each every some many most more less none all any both either neither other another such only just still even ever never always often
  note notes example examples todo warning important tip see use using used run runs running add adds added remove removes make makes made set sets get gets
  first second third next last new old true false yes not and but for are was were will would should could can may might must has have had does did done
  monday tuesday wednesday thursday friday saturday sunday january february march april june july august september october november december
  overview introduction installation install usage setup configuration config features feature requirements troubleshooting faq license licence contributing
  ctrl alt shift enter escape changelog roadmap summary background goals goal testing tests development example reference references details description options option settings
  step steps part parts section sections chapter table contents index home page pages file files folder folders project projects chat window`.split(/\s+/));
const GENERIC_HEADINGS = new Set(`overview introduction installation install usage setup configuration features requirements troubleshooting faq license contributing
  changelog roadmap summary background goals testing tests development reference references details description options settings notes example examples
  getting started how it works what is why next steps table of contents prerequisites quick start api commands`.split(/\s+/));

const MIXED_CASE = /^(?:[a-z]+[A-Z]|[A-Z][a-z0-9]+[A-Z])/;
const TOKEN = /[A-Za-z][A-Za-z0-9_]{2,39}/g;
// A definition, not a local variable: a function, class or type, or a const holding a function. Only these name the project's own things.
const DEFINITION = /\b(?:function\*?|class|interface|type|enum|def|struct|fn|func|trait|namespace)\s+([A-Za-z_]\w{2,39})|\b(?:const|let|var)\s+([A-Za-z_]\w{2,39})\s*=\s*(?:async\s*)?(?:function\b|class\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g;
const subwords = (token) => token.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g) || [token];
const WORD = /[\p{L}][\p{L}\p{N}]*/gu;
const isCapitalised = (word) => /^\p{Lu}\p{Ll}/u.test(word);

const isSecretShaped = (token) => (token.match(/\d/g) || []).length > 3 || token.length > 32;

/** True for a token worth learning from the text people send: a camelCase or PascalCase name, an acronym, or capitals mixed with digits. */
function looksLikeTerm(token) {
  if (typeof token !== 'string' || token.length < 3 || token.length > 40 || isSecretShaped(token)) return false;
  if (COMMON.has(token.toLowerCase())) return false;
  if (MIXED_CASE.test(token)) return true;
  if (/^[A-Z]{3,8}$/.test(token)) return !ACRONYM_COMMON.has(token);
  return /^[A-Za-z]+\d+[A-Za-z0-9]*$/.test(token) && /[A-Z]/.test(token); // GPT5, H100
}

/** Package names from a package.json, scope and all: "@astrojs/tailwind" gives "astrojs" and "tailwind". */
function dependencyWords(text) {
  try {
    const manifest = JSON.parse(text);
    const names = [manifest.name, ...Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })];
    return names.filter(Boolean).flatMap((name) => String(name).replace(/^@/, '').split('/'))
      .filter((word) => /^[a-z][a-z0-9]{2,}$/i.test(word) && !COMMON.has(word.toLowerCase()));
  } catch { return []; }
}

/** The project's own name from Cargo.toml, pyproject.toml or go.mod. */
function manifestName(fileName, text) {
  const pick = (pattern) => pattern.exec(text)?.[1];
  const raw = fileName === 'go.mod' ? pick(/^module\s+(\S+)/m)?.split('/').pop()
    : pick(/^\s*name\s*=\s*["']([^"']+)["']/m);
  return raw && /^[A-Za-z][\w.-]{2,39}$/.test(raw) && !COMMON.has(raw.toLowerCase()) ? raw : null;
}

/** Directory names a root .gitignore lists plainly (`dist/`, `.cache`): generated output nobody dictates about. */
function ignoredDirectories(text) {
  const names = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^\/?([A-Za-z0-9._-]+)\/?$/.exec(line.trim());
    if (match && !match[1].startsWith('!')) names.add(match[1].toLowerCase());
  }
  return names;
}

/** What a Markdown heading names: "## The `Dynamic Island` composer" gives "Dynamic Island composer", or null when it is generic prose. */
function headingPhrase(line) {
  const text = line.replace(/^#{1,4}\s+/, '').replace(/[`*_]/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^[\d.)\s]+/, '').replace(/[:.]+$/, '').trim();
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 4 || text.length > 40) return null;
  if (words.every((word) => GENERIC_HEADINGS.has(word.toLowerCase()) || PROSE_COMMON.has(word.toLowerCase()))) return null;
  if (words.length === 1) return MIXED_CASE.test(words[0]) || (/^[A-Z][A-Z0-9-]{2,}$/.test(words[0]) && !ACRONYM_COMMON.has(words[0])) ? words[0] : null; // a lone "Specification" is just a heading
  // A multi-word heading is a name only when it reads like one: every content word capitalised.
  const content = words.filter((word) => !/^(?:of|the|and|for|in|on|to|a|an|with|vs)$/i.test(word));
  return content.length >= 2 && content.every((word) => isCapitalised(word) || /^[A-Z0-9][\w-]*$/.test(word)) ? words.join(' ') : null;
}

/** Title Case runs of two or three words inside a line of prose: "Dynamic Island", "Liquid Glass Composer". */
function titleRuns(line) {
  const runs = [];
  const words = line.match(/[\p{L}][\p{L}\p{N}]*|[^\p{L}]+/gu) || [];
  let run = [];
  const flush = () => {
    while (run.length && PROSE_COMMON.has(run[0].toLowerCase())) run.shift(); // "The Dynamic Island" is "Dynamic Island"
    while (run.length && PROSE_COMMON.has(run.at(-1).toLowerCase())) run.pop();
    if (run.length >= 2 && run.length <= 3) runs.push(run.join(' '));
    run = [];
  };
  for (const piece of words) {
    if (/^\p{L}/u.test(piece) && isCapitalised(piece) && piece.length >= 3) run.push(piece);
    else if (run.length && piece === ' ') continue;
    else flush();
  }
  flush();
  return runs;
}

/** Glossary entries: "**Term** - meaning", "- `Term`: meaning", "Term: meaning" lines of a glossary file. */
function glossaryTerms(text) {
  const found = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:[-*+]\s+)?(?:\*\*([^*]{2,40})\*\*|`([^`]{2,40})`|([A-Za-z][\w .-]{1,38}?)\s*[:–—-]\s+\S)/.exec(line);
    const term = (match?.[1] || match?.[2] || match?.[3] || '').trim().replace(/[:.]+$/, '');
    if (term && term.split(/\s+/).length <= 4 && !PROSE_COMMON.has(term.toLowerCase())) found.push(term);
  }
  return found;
}

/**
 * @param {string} root project folder
 * @param {{ name?: string, limits?: Partial<typeof SCAN> }} [options] `name` is the project's own name, always offered
 * @returns {Promise<{ terms: string[], entries: Array<{ term: string, weight: number, kind: string }>, stats: { files: number, bytes: number, truncated: boolean, milliseconds: number } }>}
 *   `entries` carries each word's weight (3 for the best down to 0.6) and where it came from; `terms` is the same list as plain words.
 */
async function scanProject(root, { name = '', limits = {} } = {}) {
  const max = { ...SCAN, ...limits };
  const started = Date.now();
  const stats = { files: 0, bytes: 0, truncated: false, milliseconds: 0 };
  const words = new Map(); // token -> { count, files, declared, boost, capMid, docFiles, docAny }
  const touch = (token) => words.get(token) || words.set(token, { count: 0, files: 0, declared: false, boost: 0, capMid: 0, docFiles: 0, docAny: 0 }).get(token);
  const phrases = new Map(); // phrase -> { score, files, kind }
  const phrase = (term, kind, score, file) => {
    const entry = phrases.get(term) || phrases.set(term, { files: new Set(), kind, score: 0 }).get(term);
    if (file) entry.files.add(file);
    entry.score = Math.max(entry.score, score);
    if (score >= entry.score) entry.kind = kind;
  };
  const over = () => stats.files >= max.files || stats.bytes >= max.totalBytes || Date.now() - started > max.milliseconds;
  const readSource = async (file, count = true) => {
    const entry = await fs.promises.lstat(file);
    if (!entry.isFile() || entry.size > max.fileBytes) return null;
    if (entry.size > max.totalBytes - stats.bytes) { stats.truncated = true; return null; }
    const handle = await fs.promises.open(file, 'r');
    try {
      const bytes = Buffer.alloc(entry.size);
      const { bytesRead } = await handle.read(bytes);
      stats.bytes += bytesRead;
      if (count) stats.files++;
      return bytes.toString('utf8', 0, bytesRead);
    } finally { await handle.close(); }
  };

  const skip = new Set(SKIP_DIRS);
  try { for (const directory of ignoredDirectories(await readSource(path.join(root, '.gitignore'), false) || '')) skip.add(directory); }
  catch (error) { if (error.code !== 'ENOENT') stats.incomplete = true; }

  const dependencies = [];
  const manifestNames = [];
  const components = []; // the project's own folders: the names of its parts
  const queue = [{ directory: root, depth: 0 }];
  while (queue.length && !stats.truncated) {
    const { directory, depth } = queue.shift(); // breadth first: the project's own top level before any deep folder
    let entries;
    try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if (depth === 0 && error.code !== 'ENOENT') throw error;
      stats.incomplete = true;
      continue;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) { // a stable order: the same folder always scans the same way
      if (over()) { stats.truncated = true; break; }
      if (entry.isSymbolicLink()) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        const lower = entry.name.toLowerCase();
        if (depth < max.depth && !skip.has(lower)) queue.push({ directory: file, depth: depth + 1 });
        if (depth < 2 && !skip.has(lower) && !GENERIC_DIRS.has(lower) && !entry.name.startsWith('.') && /^[A-Za-z][\w.-]{3,39}$/.test(entry.name) && /[-_]|[a-z][A-Z]/.test(entry.name)) components.push(entry.name);
        continue;
      }
      if (!entry.isFile() || SKIP_FILES.test(entry.name)) continue;
      const extension = path.extname(entry.name).toLowerCase();
      const manifest = ['package.json', 'Cargo.toml', 'pyproject.toml', 'go.mod'].includes(entry.name);
      const isDoc = DOC_EXTENSIONS.has(extension);
      if (!manifest && !isDoc && !CODE_EXTENSIONS.has(extension)) continue;
      let text;
      try { text = await readSource(file); } catch { stats.incomplete = true; continue; }
      if (text === null) { if (stats.truncated) break; continue; }
      if (manifest) {
        if (entry.name === 'package.json') dependencies.push(...dependencyWords(text));
        else { const found = manifestName(entry.name, text); if (found) manifestNames.push(found); }
        continue;
      }
      const base = path.basename(entry.name, extension);
      const relative = path.relative(root, file);
      const isTest = TEST_FILE.test(relative);
      if (!isDoc && !isTest && MIXED_CASE.test(base) && base.length <= 40) touch(base).boost += 3; // a file named after the thing it holds
      if (text.length / (text.split('\n').length || 1) > 300) continue; // minified or generated
      const seen = new Set();
      if (!isTest) for (const match of text.matchAll(DEFINITION)) touch(match[1] || match[2]).declared = true;
      for (const [token] of text.matchAll(TOKEN)) {
        const entryFor = touch(token);
        entryFor.count++;
        if (!seen.has(token)) { seen.add(token); entryFor.files++; if (isDoc) entryFor.docAny++; }
      }
      if (isDoc) {
        const glossary = GLOSSARY_FILE.test(base);
        if (glossary) for (const term of glossaryTerms(text)) phrase(term, 'glossary', 12, relative);
        const capitalisedHere = new Set();
        let fenced = false;
        for (const raw of text.split(/\r?\n/)) {
          if (/^\s*(?:```|~~~)/.test(raw)) { fenced = !fenced; continue; }
          if (fenced) continue;
          if (/^#{1,6}\s+/.test(raw)) { const heading = headingPhrase(raw); if (heading) phrase(heading, 'heading', 3, relative); continue; } // headings are Title Case: they prove nothing about names
          if (/^\s*\|/.test(raw)) continue; // table rows are labels
          const line = raw.replace(/`[^`]*`/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/https?:\/\/\S+/g, ' ').replace(/^[\s>#*+|-]+/, '');
          const prose = line.replace(/\p{L}[\p{L}\p{N}]*(?:-\p{L}[\p{L}\p{N}]*)+/gu, ' '); // a hyphenated compound is one word, not two
          for (const run of titleRuns(prose)) phrase(run, 'phrase', 0, relative);
          // A capitalised word in the middle of a sentence is a name (Nextcloud, Whisper); one that starts a sentence proves nothing.
          const lead = /^(?:\p{Lu}[\p{L}\p{N}]*\s+)*/u.exec(prose)[0].length; // "Fleet Expansion: ..." is a label, not two names
          for (const match of prose.matchAll(WORD)) {
            const word = match[0];
            if (word.length < 4 || match.index < lead || !isCapitalised(word) || /^\p{Lu}+$/u.test(word) || PROSE_COMMON.has(word.toLowerCase()) || /(?:ing|tion|sion|ment|ness|ance|ence|ity|ism)$/i.test(word)) continue;
            const before = prose.slice(0, match.index).trimEnd();
            if (!before || /[.!?:]$/.test(before)) continue;
            touch(word).capMid++;
            capitalisedHere.add(word);
          }
        }
        for (const word of capitalisedHere) touch(word).docFiles++;
      }
    }
  }
  stats.milliseconds = Date.now() - started;

  const ranked = new Map(); // term -> { score, kind }
  const offer = (term, score, kind) => {
    const clean = String(term || '').trim();
    if (!clean || clean.length > 60) return;
    const key = clean.toLowerCase();
    if (!ranked.has(key) || ranked.get(key).score < score) ranked.set(key, { term: clean, score, kind });
  };
  for (const [token, info] of words) {
    if (COMMON.has(token.toLowerCase()) || isSecretShaped(token)) continue;
    const mixed = MIXED_CASE.test(token);
    const lowerCount = words.get(token.toLowerCase())?.count || 0;
    const acronym = /^[A-Z]{3,6}$/.test(token) && !ACRONYM_COMMON.has(token) && info.files >= 2 && info.count >= 4 && info.docAny >= 2 && lowerCount <= info.count * 0.1;
    const proper = !mixed && !acronym && info.docFiles >= 3 && info.capMid >= 4 && lowerCount <= info.capMid * 0.25 && !/^[A-Z]+$/.test(token);
    if (!mixed && !acronym && !proper) continue;
    if (mixed) {
      const pascal = /^[A-Z]/.test(token);
      const defined = info.declared || info.boost; // standard-library calls are used everywhere and defined nowhere in the project
      if (!defined && info.docAny < 2) continue;
      if (!defined && !pascal && info.docAny < 3) continue;
      if (!defined && info.files < 2) continue;
      if (!pascal && subwords(token).every((part) => GENERIC_PARTS.has(part.toLowerCase()))) continue; // createdAt, openChat
      if (!pascal && info.files < 2 && info.docAny < 2) continue; // a helper used in a single file is nobody's vocabulary
    }
    const evidence = (info.declared ? 5 : 0) + info.boost + info.files * 1.5 + Math.min(4, Math.log2(info.count + 1)) + (info.docAny >= 2 ? 2 : 0);
    offer(token, proper ? 2 + info.docFiles * 1.5 : Math.min(evidence, 14) * (mixed && !/^[A-Z]/.test(token) ? 0.6 : 1), acronym ? 'acronym' : proper ? 'name' : 'identifier');
  }
  for (const [term, info] of phrases) {
    const files = info.files.size;
    if (info.kind === 'phrase' && files < 3) continue; // a Title Case pair seen in two files is a coincidence
    offer(term, info.kind === 'glossary' ? 12 + files : info.kind === 'heading' ? 3 + files * 1.5 : 2 + files * 1.5, info.kind === 'phrase' ? 'phrase' : info.kind);
  }
  for (const part of components) offer(part, 7, 'component');
  for (const word of dependencies.slice(0, max.dependencies)) offer(word, 6, 'dependency');
  for (const manifest of manifestNames) offer(manifest, 9, 'name');
  const own = String(name || '').trim();
  if (own) offer(own, 100, 'name');

  // No kind may fill the list: identifiers are at most about half of it, so names, packages, folders and doc terms always get in.
  const sorted = [...ranked.values()].sort((a, b) => b.score - a.score || a.term.localeCompare(b.term));
  const identifierRoom = Math.ceil(max.terms * 0.55);
  let identifiers = 0;
  const ordered = [];
  for (const item of sorted) {
    if (item.kind === 'identifier' && identifiers >= identifierRoom) continue;
    if (ordered.length >= max.terms) break;
    if (item.kind === 'identifier') identifiers++;
    ordered.push(item);
  }
  ordered.sort((a, b) => b.score - a.score || a.term.localeCompare(b.term));
  const entries = ordered.map((item, index) => ({ term: item.term, kind: item.kind, weight: Math.round((3 - (2.4 * index) / Math.max(1, ordered.length - 1)) * 100) / 100 }));
  return { terms: entries.map((entry) => entry.term), entries, stats };
}

module.exports = { scanProject, looksLikeTerm, SCAN };
