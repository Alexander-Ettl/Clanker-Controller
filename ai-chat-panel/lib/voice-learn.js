'use strict';

// P17-ZA: what did the user fix in a dictated draft? Word-level LCS diff of the
// transcript against what they actually sent. A short replaced run (Whisper's
// "tech no matrix" -> "Tecnomatix") or a casing fix is a correction worth
// learning; a freshly typed word only counts when it looks like jargon
// (camelCase, PascalCase, hyphenated, letters+digits), since ordinary new
// words are just the user adding to the prompt.

const WORD = /[\p{L}\p{N}][\p{L}\p{N}_.-]*[\p{L}\p{N}]|[\p{L}\p{N}]/gu;
const MAX_TOKENS = 600;
const MAX_RUN = 3; // longer rewrites are rephrasing, not spelling fixes
const MAX_TERMS = 10;
const JARGON = /[a-z][A-Z]|^[A-Z][a-z]+[A-Z]|\p{L}-\p{L}|\p{L}\d|\d\p{L}/u;
const COMMON = new Set('the and for with that this from have what when your you are was were will would should could into then than them they there their about which also just like make made please can not but all any use using'.split(' '));

const words = (text) => (String(text || '').match(WORD) || []).slice(0, MAX_TOKENS);

/** Bigram Dice similarity: "technomatrix" vs "tecnomatix" is close, "fine" vs "great" is not. */
function similarity(a, b) {
  const grams = (s) => { const out = []; for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2)); return out; };
  const x = grams(a.toLowerCase());
  const y = grams(b.toLowerCase());
  if (!x.length || !y.length) return 0;
  const pool = [...y];
  let hits = 0;
  for (const gram of x) { const at = pool.indexOf(gram); if (at >= 0) { hits++; pool.splice(at, 1); } }
  return (2 * hits) / (x.length + y.length);
}

/** Replaced/inserted runs between two token lists, as [removed[], added[]] pairs. */
function changedRuns(a, b) {
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const runs = [];
  let removed = [];
  let added = [];
  const flush = () => { if (removed.length || added.length) runs.push([removed, added]); removed = []; added = []; };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { flush(); i++; j++; }
    else if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) added.push(b[j++]);
    else removed.push(a[i++]);
  }
  flush();
  return runs;
}

/** Terms the user corrected or introduced in `edited` relative to the dictated `original`. */
function learnedTerms(original, edited) {
  const before = words(original);
  const after = words(edited);
  if (!before.length || !after.length) return [];
  const known = new Set(before);
  const terms = new Set();
  for (const [removed, added] of changedRuns(before, after)) {
    const shortRun = removed.length > 0 && removed.length <= MAX_RUN && added.length <= MAX_RUN;
    const heard = removed.join('');
    for (const word of added) {
      if (word.length < 3 || known.has(word) || COMMON.has(word.toLowerCase()) || /^\d+$/.test(word)) continue;
      const casing = removed.some((gone) => gone.toLowerCase() === word.toLowerCase());
      const replaced = shortRun && similarity(word, heard) >= 0.4; // a respelling of what was heard, not a new thought
      if (replaced || casing || JARGON.test(word)) terms.add(word);
    }
  }
  return [...terms].slice(0, MAX_TERMS);
}

module.exports = { learnedTerms };
