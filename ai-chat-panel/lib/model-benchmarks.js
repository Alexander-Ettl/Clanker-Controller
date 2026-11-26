'use strict';

// Objective third-party benchmark data for the Auto model router (routing.js, auto-router.js).
//
// Sources (verified 2026-11-25):
//   - Artificial Analysis Intelligence Index v5 (intelligence, 0..100; speed tier)
//   - Artificial Analysis Coding Agent Index / CursorBench 4.1 / SWE-bench composite (coding, 0..100)
//   - Terminal-Bench 4.1 (terminal, % accuracy on CLI & multi-step terminal engineering)
//   - WebDev Arena / LMArena (frontend, Elo rating for visual UI & web application builds)
//
// Resolution order (best first):
//   1. User/AI-edited overrides in `routing-config.json` (`benchmarks`) or `<session>/routing-benchmarks.json`
//   2. Optional daily refresh from the free Artificial Analysis Data API (`GET /api/v2/language/models`)
//   3. Bundled verified table below (BENCHMARKS)

const fs = require('node:fs');

const VERIFIED = '2026-11-25';
const SOURCES = Object.freeze([
  'Artificial Analysis Intelligence Index v5',
  'Coding Agent / CursorBench / SWE-bench',
  'Terminal-Bench 4.1',
  'WebDev Arena (LMArena)',
]);
const AA_API_URL = 'https://artificialanalysis.ai/api/v2/language/models';
const FEED_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const EFFORT_DELTA = Object.freeze({ none: -3, minimal: -2.5, low: -2, medium: 0, high: 1, xhigh: 2, max: 2.5, ultra: 2.5 });
const SPEED_SCORE = Object.freeze({ fast: 92, medium: 66, slow: 38 });

// Normalized family rows: scores reflect standard high/default reasoning settings; effortDelta nudges variants.
const BENCHMARKS = Object.freeze({
  // Google / Antigravity
  'gemini-4-neon':   { intelligence: 61, coding: 94, terminal: 65.2, frontend: 1765, speed: 'fast',   summary: 'Frontier coding, agentic tool use & reasoning with fast efficiency (1M ctx)' },
  'gemini-4-carbon': { intelligence: 60, coding: 91, terminal: 63.5, frontend: 1769, speed: 'medium', summary: 'Frontier generalist & strong UI/long-context reasoning (1M ctx)' },
  'gemini-4-argon':  { intelligence: 52, coding: 82, terminal: 56.0, frontend: 1710, speed: 'fast',   summary: 'Solid long-context engineering workhorse (1M ctx)' },
  'gemini-3.8-flash':{ intelligence: 44, coding: 74, terminal: 48.0, frontend: 1660, speed: 'fast',   summary: 'Very fast, low-cost model for docs, research & quick edits' },
  'gemini-3.7-flash':{ intelligence: 42, coding: 71, terminal: 45.0, frontend: 1640, speed: 'fast',   summary: 'Fast model for quick lookups & lightweight tasks' },
  'gemini-3.6-flash':{ intelligence: 40, coding: 68, terminal: 42.0, frontend: 1620, speed: 'fast',   summary: 'Fast legacy Flash tier for quick tasks' },
  'gemini-3.1-pro':  { intelligence: 46, coding: 76, terminal: 50.0, frontend: 1675, speed: 'medium', summary: 'Previous-gen long-context Pro model' },
  'gemini-2.5-pro':  { intelligence: 41, coding: 70, terminal: 44.0, frontend: 1630, speed: 'medium', summary: 'Older Pro generation' },
  'gemini-2.5-flash':{ intelligence: 34, coding: 60, terminal: 35.0, frontend: 1560, speed: 'fast',   summary: 'Older lightweight Flash generation' },

  // Anthropic / Claude
  'claude-fable-5-2': { intelligence: 64, coding: 96, terminal: 66.5, frontend: 1822, speed: 'slow',   summary: 'Top frontier reasoning, architecture & frontend design' },
  'claude-fable-5-1': { intelligence: 62, coding: 94, terminal: 65.5, frontend: 1815, speed: 'slow',   summary: 'Frontier flagship for complex builds & design' },
  'claude-fable-5':   { intelligence: 60, coding: 92, terminal: 64.5, frontend: 1805, speed: 'slow',   summary: 'Heavy flagship for architecture & deep tasks' },
  'claude-opus-5-5':  { intelligence: 59, coding: 93, terminal: 65.8, frontend: 1820, speed: 'slow',   summary: 'Top-tier terminal debugging, architecture & frontend UI' },
  'claude-opus-5':    { intelligence: 56, coding: 90, terminal: 63.0, frontend: 1795, speed: 'slow',   summary: 'Strong flagship for deep engineering & UI' },
  'claude-opus-4-8':  { intelligence: 53, coding: 87, terminal: 60.0, frontend: 1765, speed: 'slow',   summary: 'Previous-gen Opus flagship' },
  'claude-opus-4-7':  { intelligence: 51, coding: 85, terminal: 58.0, frontend: 1750, speed: 'slow',   summary: 'Previous-gen Opus flagship' },
  'claude-opus-4-6':  { intelligence: 49, coding: 83, terminal: 56.0, frontend: 1735, speed: 'slow',   summary: 'Older Opus generation' },
  'claude-sonnet-5-5':{ intelligence: 57, coding: 88, terminal: 61.0, frontend: 1773, speed: 'fast',   summary: 'Fast everyday coding & strong visual/UI workhorse' },
  'claude-sonnet-5':  { intelligence: 54, coding: 85, terminal: 58.5, frontend: 1750, speed: 'fast',   summary: 'Balanced daily coding & UI model' },
  'claude-sonnet-4-6':{ intelligence: 50, coding: 82, terminal: 55.0, frontend: 1720, speed: 'fast',   summary: 'Previous-gen Sonnet coding workhorse' },
  'claude-sonnet-4-5':{ intelligence: 48, coding: 80, terminal: 53.0, frontend: 1705, speed: 'fast',   summary: 'Older Sonnet coding model' },
  'claude-haiku-4-5': { intelligence: 42, coding: 72, terminal: 44.0, frontend: 1620, speed: 'fast',   summary: 'Ultra-fast lightweight model for simple edits & lookup' },

  // OpenAI / Codex
  'gpt-6.2-astra': { intelligence: 62, coding: 93, terminal: 64.5, frontend: 1764, speed: 'slow',   summary: 'Frontier reasoning, science & complex backend engineering' },
  'gpt-6-astra':   { intelligence: 60, coding: 91, terminal: 63.0, frontend: 1761, speed: 'slow',   summary: 'High-reasoning flagship for architecture & deep debugging' },
  'gpt-6.2-sol':   { intelligence: 58, coding: 89, terminal: 61.5, frontend: 1755, speed: 'fast',   summary: 'Fast high-capability coding & backend workhorse' },
  'gpt-6.1-sol':   { intelligence: 56, coding: 87, terminal: 60.0, frontend: 1740, speed: 'fast',   summary: 'Strong everyday backend & tooling model' },
  'gpt-6-sol':     { intelligence: 54, coding: 85, terminal: 58.5, frontend: 1725, speed: 'fast',   summary: 'Balanced coding workhorse' },
  'gpt-6-luna':    { intelligence: 40, coding: 70, terminal: 43.0, frontend: 1600, speed: 'fast',   summary: 'Fast, low-cost model for simple tasks & quick checks' },
  'gpt-5.6-sol':   { intelligence: 51, coding: 83, terminal: 56.0, frontend: 1700, speed: 'fast',   summary: 'Previous-gen Codex workhorse' },
  'gpt-5.6-terra': { intelligence: 48, coding: 79, terminal: 52.0, frontend: 1675, speed: 'fast',   summary: 'Previous-gen mid-tier Codex model' },
  'gpt-5.6-luna':  { intelligence: 38, coding: 66, terminal: 40.0, frontend: 1580, speed: 'fast',   summary: 'Previous-gen lightweight Codex model' },
  'gpt-5.5':       { intelligence: 50, coding: 81, terminal: 54.0, frontend: 1690, speed: 'medium', summary: 'Previous-gen GPT flagship' },
  'gpt-5.4':       { intelligence: 48, coding: 79, terminal: 52.0, frontend: 1670, speed: 'medium', summary: 'Older GPT-5 generation' },
});

const ALIASES = Object.freeze({
  'gemini-flash': 'gemini-3.8-flash',
  'gemini-pro': 'gemini-3.1-pro',
  'gemini-neon': 'gemini-4-neon',
  'gemini-carbon': 'gemini-4-carbon',
  'gemini-argon': 'gemini-4-argon',
  'gpt-sol': 'gpt-6.2-sol',
  'gpt-astra': 'gpt-6.2-astra',
  'gpt-luna': 'gpt-6-luna',
  'gpt-terra': 'gpt-5.6-terra',
  'gpt-reserve': 'gpt-6.1-sol',
  'codex-auto-review': 'gpt-5.6-sol',
});

function extractEffort(entry) {
  if (entry?.effort && EFFORTS.includes(String(entry.effort).toLowerCase())) {
    return String(entry.effort).toLowerCase();
  }
  const raw = String(entry?.model || entry?.id || entry?.label || '').toLowerCase();
  const match = /(?:[-\s(])(none|minimal|low|medium|high|xhigh|max|ultra)\)?$/.exec(raw);
  return match ? match[1] : '';
}

/** Normalizes any CLI model id or label into the benchmark table key (without provider prefix or effort suffix). */
function normalizeBenchmarkId(modelOrEntry) {
  const raw = typeof modelOrEntry === 'string'
    ? modelOrEntry
    : (modelOrEntry?.model || modelOrEntry?.id || modelOrEntry?.label || '');
  let id = String(raw).trim().toLowerCase();
  // Strip cross-provider route prefix like `gemini:` or `copilot:`
  id = id.replace(/^(?:claude|codex|gemini|copilot):/, '');
  id = id.replace(/[()]/g, ' ').replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  for (let i = 0; i < 3; i++) {
    id = id.replace(/-(none|minimal|low|medium|high|xhigh|max|ultra|thinking|preview|latest|\d{8})$/, '');
  }
  if (id.startsWith('claude-')) id = id.replace(/(\d)\.(\d)/g, '$1-$2');
  return ALIASES[id] || id;
}

function sanitizeRow(row) {
  if (!row || typeof row !== 'object') return null;
  const num = (v, min, max) => (Number.isFinite(Number(v)) ? Math.max(min, Math.min(max, Number(v))) : null);
  const intelligence = num(row.intelligence, 0, 100);
  const coding = num(row.coding, 0, 100);
  const terminal = num(row.terminal, 0, 100);
  const frontend = num(row.frontend, 800, 2600);
  if (intelligence == null && coding == null && terminal == null && frontend == null) return null;
  const speed = ['fast', 'medium', 'slow'].includes(row.speed) ? row.speed : 'medium';
  const summary = typeof row.summary === 'string' ? row.summary.slice(0, 140) : '';
  return { intelligence, coding, terminal, frontend, speed, summary };
}

/**
 * Looks up third-party benchmark metrics for a discovered model entry.
 * Returns null for unknown/synthetic ids so unit tests and custom unknown models keep clean fallback behavior.
 */
function benchmarkFor(modelOrEntry, overrides = null) {
  const rawId = typeof modelOrEntry === 'string' ? modelOrEntry : (modelOrEntry?.id || '');
  const norm = normalizeBenchmarkId(modelOrEntry);
  const labelNorm = typeof modelOrEntry === 'object' && modelOrEntry?.label ? normalizeBenchmarkId(modelOrEntry.label) : '';
  const candidates = [rawId, norm, labelNorm].filter(Boolean);

  let base = null;
  let source = 'bundled';
  let matchedKey = norm;

  if (overrides && typeof overrides === 'object') {
    for (const key of candidates) {
      if (overrides[key]) {
        const clean = sanitizeRow(overrides[key]);
        if (clean) {
          base = { ...(BENCHMARKS[norm] || BENCHMARKS[labelNorm] || {}), ...clean };
          source = overrides[key].source || 'override';
          matchedKey = key;
          break;
        }
      }
    }
  }
  if (!base) {
    for (const key of candidates) {
      if (BENCHMARKS[key]) {
        base = { ...BENCHMARKS[key] };
        matchedKey = key;
        break;
      }
    }
  }
  if (!base) return null;

  const effort = extractEffort(modelOrEntry);
  const delta = effort ? (EFFORT_DELTA[effort] ?? 0) : 0;
  const nudge = (val, scale = 1, max = 100) => (val == null ? null : Number(Math.max(0, Math.min(max, val + delta * scale)).toFixed(1)));
  return {
    key: matchedKey,
    source,
    effort: effort || null,
    intelligence: nudge(base.intelligence, 0.7, 100),
    coding: nudge(base.coding, 0.8, 100),
    terminal: nudge(base.terminal, 0.6, 100),
    frontend: base.frontend == null ? null : Math.round(base.frontend + delta * 5),
    speed: base.speed || 'medium',
    summary: base.summary || '',
  };
}

/** Compact one-line benchmark summary for a single candidate's description sent to Clef/Groq. */
function benchmarkBrief(model, { quotaPct = null, overrides = null } = {}) {
  const b = benchmarkFor(model, overrides);
  const parts = [];
  if (b) {
    const scores = [];
    if (b.intelligence != null) scores.push(`AA-Int ${b.intelligence}`);
    if (b.coding != null) scores.push(`Coding ${b.coding}`);
    if (b.terminal != null) scores.push(`Terminal ${b.terminal}%`);
    if (b.frontend != null) scores.push(`WebDev ${b.frontend}`);
    if (scores.length) parts.push(`Benchmarks: ${scores.join(', ')}`);
    if (b.speed) parts.push(`speed ${b.speed}`);
  }
  if (Number.isFinite(quotaPct)) parts.push(`quota ${Math.round(quotaPct)}% left`);
  return parts.join('; ');
}

/**
 * Objective, easy-to-read table handed to Clef / Groq so the decision model compares eligible candidates
 * directly on third-party category benchmarks alongside real remaining quota.
 * Returns null if none of the eligible candidates have benchmark entries.
 */
function benchmarkTable(models, { quotaPctFor = () => null, overrides = null } = {}) {
  const rows = [];
  let hasAny = false;
  for (const m of models || []) {
    const b = benchmarkFor(m, overrides);
    if (b) hasAny = true;
    const q = quotaPctFor(m);
    rows.push({
      id: m.id,
      intelligence: b?.intelligence ?? '-',
      coding: b?.coding ?? '-',
      terminal: b?.terminal != null ? `${b.terminal}%` : '-',
      frontend: b?.frontend ?? '-',
      speed: b?.speed ?? '-',
      quota: Number.isFinite(q) ? `${Math.round(q)}%` : 'unknown',
    });
  }
  if (!hasAny) return null;
  const header = 'Model | AA-Intelligence | Coding | Terminal-Bench | WebDev-Arena | Speed | Quota-Left';
  const lines = rows.map((r) => `${r.id} | ${r.intelligence} | ${r.coding} | ${r.terminal} | ${r.frontend} | ${r.speed} | ${r.quota}`);
  return {
    verified: VERIFIED,
    sources: [...SOURCES],
    table: [header, ...lines].join('\n'),
  };
}

// Normalize heterogeneous third-party scales onto a clean 0..100 basis for category weighting.
const normIntelligence = (v) => Math.max(0, Math.min(100, ((v - 30) / 40) * 100));
const normCoding = (v) => Math.max(0, Math.min(100, v));
const normTerminal = (v) => Math.max(0, Math.min(100, ((v - 30) / 42) * 100));
const normFrontend = (v) => Math.max(0, Math.min(100, ((v - 1500) / 360) * 100));

const CATEGORY_WEIGHTS = Object.freeze({
  visual:      { frontend: 0.50, coding: 0.25, intelligence: 0.15, terminal: 0.00, speed: 0.10 },
  backend:     { terminal: 0.40, coding: 0.35, intelligence: 0.20, frontend: 0.00, speed: 0.05 },
  build:       { coding: 0.40, intelligence: 0.35, terminal: 0.20, frontend: 0.05, speed: 0.00 },
  information: { speed: 0.45, intelligence: 0.35, coding: 0.15, terminal: 0.00, frontend: 0.05 },
  unspecified: { coding: 0.35, intelligence: 0.30, terminal: 0.15, frontend: 0.10, speed: 0.10 },
});

/**
 * Objective 0..100 fit score for a model on a given task category, difficulty (0..1), and remaining quota (%).
 * Returns null if the model has no benchmark data.
 */
function categoryFitScore(model, { purpose = 'unspecified', difficulty = 0.5, quotaPct = null, overrides = null } = {}) {
  const b = benchmarkFor(model, overrides);
  if (!b) return null;
  const baseWeights = CATEGORY_WEIGHTS[purpose] || CATEGORY_WEIGHTS.unspecified;
  // For trivial/low-complexity tasks (<= 0.3), boost speed weight so quick questions prefer fast models.
  const weights = difficulty <= 0.3 && purpose !== 'information'
    ? { ...baseWeights, speed: baseWeights.speed + 0.25 }
    : baseWeights;

  const scores = {
    intelligence: b.intelligence != null ? normIntelligence(b.intelligence) : null,
    coding: b.coding != null ? normCoding(b.coding) : null,
    terminal: b.terminal != null ? normTerminal(b.terminal) : null,
    frontend: b.frontend != null ? normFrontend(b.frontend) : null,
    speed: SPEED_SCORE[b.speed] ?? SPEED_SCORE.medium,
  };

  let weighted = 0;
  let totalWeight = 0;
  for (const [axis, w] of Object.entries(weights)) {
    if (w > 0 && scores[axis] != null) {
      weighted += scores[axis] * w;
      totalWeight += w;
    }
  }
  if (!totalWeight) return null;
  let score = weighted / totalWeight;

  // Quota health modulation: keep high-capability models ahead when healthy, gently steer away as quota gets tight.
  if (Number.isFinite(quotaPct)) {
    if (quotaPct <= 0) score -= 100;
    else if (quotaPct < 15) score -= 18;
    else if (quotaPct < 30) score -= (30 - quotaPct) * 0.4;
  }
  return Number(score.toFixed(2));
}

/** Parses Artificial Analysis Data API v2 response (`{ data: [...] }`) into Clanker's normalized override map. */
function parseArtificialAnalysisResponse(payload) {
  const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
  const out = {};
  for (const item of list) {
    const slug = normalizeBenchmarkId(item?.slug || item?.name || '');
    if (!slug) continue;
    const evals = item?.evaluations || {};
    const intelligence = evals.artificial_analysis_intelligence_index ?? evals.intelligence_index;
    const coding = evals.artificial_analysis_coding_index ?? evals.coding_index;
    const terminal = evals.terminal_bench_hard ?? evals.terminal_bench;
    const tps = Number(item?.median_output_tokens_per_second);
    const speed = Number.isFinite(tps) ? (tps >= 85 ? 'fast' : tps >= 40 ? 'medium' : 'slow') : undefined;
    const existing = BENCHMARKS[slug] || {};
    const row = sanitizeRow({
      intelligence: intelligence ?? existing.intelligence,
      coding: coding != null ? (coding <= 1 ? coding * 100 : coding) : existing.coding,
      terminal: terminal != null ? (terminal <= 1 ? terminal * 100 : terminal) : existing.terminal,
      frontend: existing.frontend,
      speed: speed || existing.speed,
      summary: existing.summary,
    });
    if (row) out[slug] = { ...row, source: 'artificial-analysis-live' };
  }
  return out;
}

async function fetchArtificialAnalysis(apiKey, fetchImpl = globalThis.fetch) {
  if (!apiKey || typeof fetchImpl !== 'function') return null;
  const response = await fetchImpl(AA_API_URL, {
    headers: { 'x-api-key': apiKey, Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`Artificial Analysis API HTTP ${response.status}`);
  const payload = await response.json();
  return parseArtificialAnalysisResponse(payload);
}

/** Reads an optional user/AI-edited JSON override file (`<session>/routing-benchmarks.json`). */
function loadOverrideFile(file) {
  if (!file) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const entries = raw?.models && typeof raw.models === 'object' ? raw.models : raw;
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return {};
    const out = {};
    for (const [id, row] of Object.entries(entries)) {
      const clean = sanitizeRow(row);
      if (clean) out[normalizeBenchmarkId(id) || id] = { ...clean, source: 'custom' };
    }
    return out;
  } catch {
    return {};
  }
}

module.exports = {
  AA_API_URL,
  BENCHMARKS,
  CATEGORY_WEIGHTS,
  FEED_MAX_AGE_MS,
  SOURCES,
  VERIFIED,
  benchmarkBrief,
  benchmarkFor,
  benchmarkTable,
  categoryFitScore,
  fetchArtificialAnalysis,
  loadOverrideFile,
  normalizeBenchmarkId,
  parseArtificialAnalysisResponse,
};
