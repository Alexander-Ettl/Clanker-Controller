'use strict';

// Turns a project checkout into the numbered, size-bounded text each scout reads. Nothing here is specific to one project layout:
// files are ranked per question (path, content, recent change), the best fill the budget, and large files are cut to the regions
// around the code the question cares about. The lines that were supplied are remembered so a cited line can be checked.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { git } = require('./loop-exec');
const { SECRETS, SKIP_DIRS, inside, listProjectFiles } = require('./loop-workspace');

const TEXT_EXT = /\.(?:[cm]?[jt]sx?|vue|svelte|astro|py|rb|php|go|rs|swift|kt|java|cs|c|cc|cpp|h|hpp|m|mm|css|scss|less|html?|md|mdx|json|ya?ml|toml|sh|ps1|sql|graphql|prisma|xml|plist|gradle|csproj)$/i;
const NOISE = /(?:^|\/)(?:vendor|third[_-]?party|dist|build|out|coverage|public\/vendor|\.astro|\.visor)(?:\/|$)|\.min\.|\.bundle\.|\.map$|(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|composer\.lock)$/i;
const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|spec|e2e|fixtures?)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_.*\.py$|_test\.go$/i;
const MAX_SOURCE_BYTES = 400 * 1024;

const digest = text => crypto.createHash('sha256').update(text).digest('hex');
const isSource = file => TEXT_EXT.test(file) && !NOISE.test(file) && !SKIP_DIRS.test(file) && !SECRETS.test(file);

/** The source files of a checkout as `Map(file -> text)`. */
function readContents(checkout) {
  const contents = new Map();
  for (const file of listProjectFiles(checkout).filter(isSource).sort()) {
    const full = path.resolve(checkout, file);
    try { if (inside(checkout, full) && fs.statSync(full).size <= MAX_SOURCE_BYTES) contents.set(file, fs.readFileSync(full, 'utf8')); } catch { /* deleted or unreadable: not supplied */ }
  }
  return contents;
}

/**
 * What changed lately in the real project: the files touched by recent commits or uncommitted edits, plus a bounded diff.
 * Used by the "recent changes" scout; empty outside git.
 */
function recentChanges(root, { commits = 12, maxDiff = 90000 } = {}) {
  const run = args => git(root, args, { allowFail: true });
  if (!run(['rev-parse', '--git-dir']).trim()) return { files: new Set(), diff: '' };
  const names = [...run(['log', `-n${commits}`, '--name-only', '--pretty=format:']).split(/\r?\n/), ...run(['status', '--porcelain']).split(/\r?\n/).map(line => line.slice(3).replace(/^"|"$/g, ''))]
    .map(name => name.trim().replace(/\\/g, '/')).filter(Boolean);
  const uncommitted = run(['diff', 'HEAD', '--no-color', '-U3']);
  const history = run(['log', `-n${Math.min(commits, 6)}`, '-p', '--no-color', '-U2', '--pretty=format:### %h %s']);
  const diff = `${uncommitted ? `## Uncommitted changes\n${uncommitted}\n` : ''}${history ? `## Recent commits\n${history}\n` : ''}`.slice(0, maxDiff);
  return { files: new Set(names), diff };
}

/** Lines of `body` to show when it is too large: windows around keyword hits, else the top of the file. */
function excerptLines(lines, keywords, limitChars) {
  const picked = new Set();
  let hits = 0;
  if (keywords) for (let i = 0; i < lines.length && hits < 10; i++) {
    if (keywords.test(lines[i]) && !picked.has(i)) { hits++; for (let n = Math.max(0, i - 8); n < Math.min(lines.length, i + 28); n++) picked.add(n); }
  }
  if (!picked.size) for (let n = 0; n < Math.min(lines.length, 140); n++) picked.add(n);
  let used = 0; const chosen = [];
  for (const index of [...picked].sort((a, b) => a - b)) { const row = `${index + 1}: ${lines[index]}\n`; if (used + row.length > limitChars) break; used += row.length; chosen.push(index); }
  return chosen;
}

function scoreFile(file, body, aspect, recent) {
  let score = 1;
  const focused = aspect.focus ? aspect.focus.test(file) : recent.has(file);
  if (focused) score += 3;
  if (recent.has(file)) score += aspect.recent ? 8 : 2;
  if (aspect.keywords) { const sample = body.slice(0, 40000); const hits = sample.match(new RegExp(aspect.keywords.source, `g${aspect.keywords.flags.replace('g', '')}`))?.length || 0; score += Math.min(3, hits / 6); }
  if (TEST_PATH.test(file) && !aspect.tests && !aspect.recent) score -= 2;
  if (/\.md$/i.test(file) && aspect.id !== 'contracts' && !aspect.docs) score -= 1;
  if (/\.json$/i.test(file) && aspect.id !== 'contracts') score -= 1;
  return aspect.recent && !recent.has(file) ? score - 2 : score;
}

/**
 * The packet one scout reads. `cycle` rotates which slice of a project larger than the budget a scout sees, so successive
 * cycles cover different files instead of re-reading the same best ones. Returns the text and the lines it contains.
 */
function buildAspectPacket(contents, aspect, { budget = 200000, cycle = 0, recent = new Set(), maxShards = 4 } = {}) {
  const ranked = [...contents].filter(([file]) => /\.(?:md|mdx)$/i.test(file) ? aspect.id === 'contracts' || aspect.id === 'regression' || aspect.docs || recent.has(file) : true)
    .map(([file, body]) => ({ file, body, score: scoreFile(file, body, aspect, recent), size: Math.min(body.length, 24000) }))
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  const total = ranked.reduce((sum, item) => sum + item.size, 0);
  const shards = Math.max(1, Math.min(maxShards, Math.ceil(total / budget)));
  const shard = cycle % shards;
  let skip = shard * budget, used = 0, packet = '', included = 0;
  const supplied = new Map();
  for (const item of ranked) {
    if (skip > 0) { skip -= item.size; continue; }
    if (used >= budget) break;
    const lines = item.body.split('\n');
    const limit = Math.min(24000, budget - used);
    const wanted = item.body.length <= limit ? lines.map((_, index) => index) : excerptLines(lines, aspect.keywords, Math.min(14000, limit));
    let excerpt = '';
    const lineNumbers = new Set();
    for (const index of wanted) { const row = `${index + 1}: ${lines[index]}\n`; if (excerpt.length + row.length > limit) break; excerpt += row; lineNumbers.add(index + 1); }
    if (!excerpt) continue;
    packet += `\nFILE ${item.file}\n${excerpt}`;
    used += excerpt.length; included++;
    supplied.set(item.file, { lines: lineNumbers });
  }
  return { packet, supplied, files: included, total: ranked.length, shards, shard };
}

/** Numbered text around each cited line of a finding, from the checkout as it is now. Verifiers read this, not the scout's quote. */
function excerptAround(contents, evidence, radius = 25, maxChars = 5000) {
  const blocks = [];
  for (const item of evidence.slice(0, 3)) {
    const body = contents.get(item.file);
    if (typeof body !== 'string') continue;
    const lines = body.split('\n');
    const from = Math.max(0, item.line - 1 - radius), to = Math.min(lines.length, item.line + radius);
    let text = '';
    for (let n = from; n < to; n++) text += `${n + 1}: ${lines[n]}\n`;
    blocks.push(`FILE ${item.file} (cited line ${item.line})\n${text.slice(0, maxChars)}`);
  }
  return blocks.join('\n');
}

/** Every line number of every file in `contents`, for validating the evidence a verifier or judge cites. */
function allLines(contents) {
  const map = new Map();
  for (const [file, body] of contents) map.set(file, body);
  return map;
}

module.exports = { readContents, recentChanges, buildAspectPacket, excerptAround, allLines, isSource, digest, MAX_SOURCE_BYTES };
