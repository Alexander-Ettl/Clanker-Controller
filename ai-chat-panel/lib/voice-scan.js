'use strict';

// Reads a project folder for the technical words dictation tends to get wrong (its own class, function and package
// names, mixed-case identifiers, acronyms) and returns the best few, most telling first. Local and read-only: nothing is
// sent anywhere, and every loop is bounded so a huge repository costs a few seconds, not minutes.

const fs = require('node:fs');
const path = require('node:path');

const SCAN = Object.freeze({
  files: 1200,            // files read
  fileBytes: 256 * 1024,  // a larger file is generated or data, not source
  totalBytes: 6 * 1024 * 1024,
  depth: 8,
  milliseconds: 5000,
  terms: 60,              // words returned (the dictionary's own scanBatch limit applies on top)
  dependencies: 25,
});
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', 'vendor', 'target', 'bin', 'obj', '.venv', 'venv',
  '__pycache__', '.next', '.nuxt', '.astro', '.svelte-kit', '.cache', '.turbo', '.migration-backup', '.idea', '.vs', 'recordings', '.recordings']);
const TEXT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue', '.svelte', '.astro', '.py', '.rb', '.go', '.rs', '.java', '.kt',
  '.cs', '.cpp', '.cc', '.c', '.h', '.hpp', '.php', '.swift', '.lua', '.dart', '.scala', '.sh', '.ps1', '.sql', '.md', '.mdx', '.txt']);
const SKIP_FILES = /^(?:\.env.*|.*\.min\.[a-z]+|.*\.(?:pem|key|p12|pfx)|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i;

// Identifiers nearly every project of a kind uses: they would fill the list in any repository and teach Whisper nothing.
const COMMON = new Set(`getelementbyid addeventlistener removeeventlistener queryselector queryselectorall createelement appendchild
  removechild textcontent innerhtml outerhtml classlist setattribute getattribute foreach settimeout cleartimeout setinterval clearinterval
  json stringify parseint parsefloat promise async await tostring hasownproperty isarray isnan undefined nullable preventdefault
  stoppropagation stopimmediatepropagation postmessage readfilesync writefilesync existssync mkdirsync readdirsync statsync unlinksync
  console log error warn debug info html css http https url uri api sdk cli gui ide json xml yaml toml csv utf ascii uuid guid
  true false null void this self super constructor prototype module exports require import default return`.split(/\s+/));
const ACRONYM_COMMON = new Set('API SDK CLI GUI IDE JSON XML YAML TOML CSV UTF HTML CSS HTTP HTTPS URL URI UUID GUID TODO FIXME NOTE README MIT GET POST PUT PATCH DELETE'.split(' '));

const MIXED_CASE = /^(?:[a-z]+[A-Z]|[A-Z][a-z0-9]+[A-Z])/;
const TOKEN = /[A-Za-z][A-Za-z0-9_]{2,39}/g;
const DECLARATION = /\b(?:function\*?|class|interface|type|enum|const|let|var|def|struct|fn|func|trait|object|namespace)\s+([A-Za-z_]\w{2,39})/g;

const isSecretShaped = (token) => (token.match(/\d/g) || []).length > 3 || token.length > 32;

/** Package names from a package.json, scope and all: "@astrojs/tailwind" gives "astrojs" and "tailwind". */
function dependencyWords(text) {
  try {
    const manifest = JSON.parse(text);
    const names = [manifest.name, ...Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })];
    return names.filter(Boolean).flatMap((name) => String(name).replace(/^@/, '').split('/'))
      .filter((word) => /^[a-z][a-z0-9]{2,}$/i.test(word) && !COMMON.has(word.toLowerCase()));
  } catch { return []; }
}

/**
 * @param {string} root project folder
 * @param {{ name?: string, limits?: Partial<typeof SCAN> }} [options] `name` is the project's own name, always offered
 * @returns {Promise<{ terms: string[], stats: { files: number, bytes: number, truncated: boolean, milliseconds: number } }>}
 */
async function scanProject(root, { name = '', limits = {} } = {}) {
  const max = { ...SCAN, ...limits };
  const started = Date.now();
  const stats = { files: 0, bytes: 0, truncated: false, milliseconds: 0 };
  const words = new Map(); // token -> { count, files, declared, boost }
  const touch = (token) => words.get(token) || words.set(token, { count: 0, files: 0, declared: false, boost: 0 }).get(token);
  const over = () => stats.files >= max.files || stats.bytes >= max.totalBytes || Date.now() - started > max.milliseconds;

  const dependencies = [];
  const queue = [{ directory: root, depth: 0 }];
  while (queue.length && !stats.truncated) {
    const { directory, depth } = queue.shift(); // breadth first: the project's own top level before any deep folder
    let entries;
    try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (over()) { stats.truncated = true; break; }
      if (entry.isSymbolicLink()) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (depth < max.depth && !SKIP_DIRS.has(entry.name.toLowerCase())) queue.push({ directory: file, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile() || SKIP_FILES.test(entry.name)) continue;
      const extension = path.extname(entry.name).toLowerCase();
      if (entry.name === 'package.json') { // dependencies are the strongest signal there is
        try { dependencies.push(...dependencyWords(await fs.promises.readFile(file, 'utf8'))); } catch { /* unreadable */ }
        continue;
      }
      if (!TEXT_EXTENSIONS.has(extension)) continue;
      const base = path.basename(entry.name, extension);
      if (MIXED_CASE.test(base) && base.length <= 40) touch(base).boost += 3; // a file named after the thing it holds
      let text;
      try {
        const stat = await fs.promises.stat(file);
        if (stat.size > max.fileBytes) continue;
        text = await fs.promises.readFile(file, 'utf8');
        stats.bytes += stat.size;
      } catch { continue; }
      if (text.length / (text.split('\n').length || 1) > 300) continue; // minified or generated
      stats.files++;
      const seen = new Set();
      for (const [, declared] of text.matchAll(DECLARATION)) touch(declared).declared = true;
      for (const [token] of text.matchAll(TOKEN)) {
        const entryFor = touch(token);
        entryFor.count++;
        if (!seen.has(token)) { seen.add(token); entryFor.files++; }
      }
    }
  }
  stats.milliseconds = Date.now() - started;

  const ranked = [];
  for (const [token, info] of words) {
    if (COMMON.has(token.toLowerCase()) || isSecretShaped(token)) continue;
    const mixed = MIXED_CASE.test(token);
    const acronym = /^[A-Z]{3,8}$/.test(token) && !ACRONYM_COMMON.has(token) && info.files >= 2 && info.count >= 4;
    if (!mixed && !acronym) continue;
    if (mixed && !info.declared && info.files < 2 && !info.boost) continue; // one-off local names are not vocabulary
    ranked.push({ token, score: (info.declared ? 5 : 0) + info.boost + info.files * 1.5 + Math.log2(info.count + 1) });
  }
  ranked.sort((a, b) => b.score - a.score || a.token.localeCompare(b.token));

  const seen = new Set();
  const terms = [String(name || '').trim(), ...dependencies.slice(0, max.dependencies), ...ranked.map((entry) => entry.token)]
    .filter((term) => term && term.length <= 60 && !seen.has(term.toLowerCase()) && seen.add(term.toLowerCase()))
    .slice(0, max.terms);
  return { terms, stats };
}

module.exports = { scanProject, SCAN };
