'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  benchmarkFor,
  benchmarkTable,
  categoryFitScore,
  fetchArtificialAnalysis,
  loadOverrideFile,
  normalizeBenchmarkId,
  parseArtificialAnalysisResponse,
} = require('../lib/model-benchmarks.js');
const { Router } = require('../lib/routing.js');
const { route } = require('../lib/auto-router.js');
const { setModelCatalog, setFavoriteModels } = require('../lib/model-catalog.js');

const FLEET = [
  { id: 'gemini-4-neon-high', model: 'gemini-4-neon-high', agent: 'gemini', effort: 'high', label: 'Gemini 4 Neon High', context: 1000000, vision: true },
  { id: 'gemini-3.8-flash-high', model: 'gemini-3.8-flash-high', agent: 'gemini', effort: 'high', label: 'Gemini 3.8 Flash High', context: 1000000, vision: true },
  { id: 'claude-opus-5-5-max', model: 'claude-opus-5-5', agent: 'claude', effort: 'max', label: 'Claude Opus 5.5 Max', context: 200000, vision: true, brand: 'opus' },
  { id: 'claude-sonnet-5-5-high', model: 'claude-sonnet-5-5', agent: 'claude', effort: 'high', label: 'Claude Sonnet 5.5 High', context: 200000, vision: true },
  { id: 'gpt-6.2-sol-high', model: 'gpt-6.2-sol', agent: 'codex', effort: 'high', label: 'GPT-6.2 Sol High', context: 272000, vision: true },
];

test('normalizeBenchmarkId strips provider prefixes, effort suffixes and handles unknown synthetic IDs', () => {
  assert.equal(normalizeBenchmarkId('gemini-4-neon-high'), 'gemini-4-neon');
  assert.equal(normalizeBenchmarkId('gemini:claude-sonnet-5.5-high'), 'claude-sonnet-5-5');
  assert.equal(normalizeBenchmarkId('GPT-6.2 Sol (High)'), 'gpt-6.2-sol');
  assert.equal(benchmarkFor({ id: 'synthetic-test-model', agent: 'codex' }), null);
  const neon = benchmarkFor(FLEET[0]);
  assert.ok(neon && neon.coding >= 90 && neon.intelligence >= 60);
});

test('Clef and Groq both receive an objective benchmark + quota table and enriched candidate criteria', async () => {
  const cfCalls = [];
  const secrets = { get: async (k) => (k === 'routingCloudflareAccount' ? 'a'.repeat(32) : 'secret') };
  const router = new Router({
    getConfig: () => ({ router_mode: 'auto' }),
    secrets,
    store: { get: () => ({}), set: () => {} },
    fetchImpl: async (_url, req) => {
      cfCalls.push(JSON.parse(req.body));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          result: {
            answers: {
              pick: { choice: 'gemini-4-neon-high', confidence: 0.92, probabilities: { 'gemini-4-neon-high': 0.92, 'claude-opus-5-5-max': 0.08 } },
              complexity: { score: 2.6 },
              needs_vision: { noul: 0 },
              needs_long_context: { noul: 0 },
              continuation: { noul: 1 },
            },
          },
        }),
      };
    },
  });

  const quotas = { gemini: { remaining: 88 }, claude: { remaining: 72 }, opus: { remaining: 65 }, codex: { remaining: 64 } };
  const result = await router.route({ prompt: 'Implement the new websocket reconnection state machine' }, FLEET, quotas);
  assert.equal(result.pick, 'gemini-4-neon-high');
  assert.equal(cfCalls.length, 1);
  const { state, questions } = cfCalls[0];
  assert.ok(state.benchmarks && typeof state.benchmarks.table === 'string');
  assert.match(state.benchmarks.table, /Model \| AA-Intelligence \| Coding \| Terminal-Bench \| WebDev-Arena \| Speed \| Quota-Left/);
  assert.match(state.benchmarks.table, /gemini-4-neon-high \| .* \| 88%/);
  assert.match(state.benchmarks.table, /claude-opus-5-5-max \| .* \| 65%/);
  assert.match(questions.pick.criteria['gemini-4-neon-high'], /Benchmarks: AA-Int .* Coding .* Terminal .* WebDev .* quota 88% left/);
  assert.doesNotMatch(Object.values(questions.pick.criteria).join(' '), /capacity/i);
});

test('categoryFitScore and deterministic routing match categories to relevant benchmarks and respect quota health', async () => {
  const quotas = { gemini: { remaining: 90 }, claude: { remaining: 90 }, opus: { remaining: 90 }, codex: { remaining: 90 } };
  const neonBuild = categoryFitScore(FLEET[0], { purpose: 'build', difficulty: 0.85, quotaPct: 90 });
  const flashBuild = categoryFitScore(FLEET[1], { purpose: 'build', difficulty: 0.85, quotaPct: 90 });
  assert.ok(neonBuild > flashBuild + 15, `Neon (${neonBuild}) should clearly beat Flash (${flashBuild}) on complex builds`);

  const opusVisual = categoryFitScore(FLEET[2], { purpose: 'visual', difficulty: 0.5, quotaPct: 90 });
  const flashVisual = categoryFitScore(FLEET[1], { purpose: 'visual', difficulty: 0.5, quotaPct: 90 });
  assert.ok(opusVisual > flashVisual + 15, `Opus (${opusVisual}) should clearly beat Flash (${flashVisual}) on visual UI work`);

  const router = new Router({
    getConfig: () => ({ router_mode: 'auto', tiers: ['deterministic'], balance_providers: false }),
    store: { get: () => ({}), set: () => {} },
  });

  // Visual design picks top WebDev Arena model (Opus 5.5 Max).
  const vis = await router.route({ prompt: 'Redesign the visual layout and CSS styling to look beautiful' }, FLEET, quotas);
  assert.equal(vis.pick, 'claude-opus-5-5-max');

  // Complex build with Neon vs Flash (both high effort!) picks Neon, never Flash.
  const build = await router.route({ prompt: 'Build a new app from scratch with initial architecture' }, [FLEET[1], FLEET[0]], quotas);
  assert.equal(build.pick, 'gemini-4-neon-high');

  // Quick documentation lookup prefers a fast model (Neon/Sonnet/Sol/Flash) over slow Opus.
  const info = await router.route({ prompt: 'Search documentation and look up the config options' }, FLEET, quotas);
  assert.notEqual(info.pick, 'claude-opus-5-5-max');

  // When Gemini quota is depleted (0%), router excludes Gemini models and picks the next strongest model.
  const lowQ = await router.route({ prompt: 'Build a new app from scratch' }, FLEET, { ...quotas, gemini: { remaining: 0 } });
  assert.notEqual(lowQ.pick, 'gemini-4-neon-high');
  assert.equal(lowQ.excluded_models['gemini-4-neon-high'], 'quota exhausted');
});

test('auto-router offline fallback uses benchmark ranking rather than blind effort', () => {
  setModelCatalog([FLEET[1], FLEET[0]]);
  setFavoriteModels([FLEET[1], FLEET[0]]);
  const picked = route('Build a complex new backend architecture from scratch', { gemini: { remaining: 85 } }, 'auto');
  assert.equal(picked.modelId, 'gemini-4-neon-high');
});

test('Artificial Analysis API parser and routing-benchmarks.json override file update scores immediately', async () => {
  const parsed = parseArtificialAnalysisResponse({
    data: [
      {
        slug: 'gemini-4-neon',
        evaluations: { artificial_analysis_intelligence_index: 67, artificial_analysis_coding_index: 97, terminal_bench_hard: 0.71 },
        median_output_tokens_per_second: 120,
      },
    ],
  });
  assert.equal(parsed['gemini-4-neon'].intelligence, 67);
  assert.equal(parsed['gemini-4-neon'].coding, 97);
  assert.equal(parsed['gemini-4-neon'].terminal, 71);
  assert.equal(parsed['gemini-4-neon'].speed, 'fast');

  const live = await fetchArtificialAnalysis('aa-test-key', async (url, opts) => {
    assert.match(url, /artificialanalysis\.ai\/api\/v2\/language\/models/);
    assert.equal(opts.headers['x-api-key'], 'aa-test-key');
    return { ok: true, status: 200, json: async () => ({ data: [{ slug: 'brand-new-model', evaluations: { intelligence_index: 70, coding_index: 99 }, median_output_tokens_per_second: 110 }] }) };
  });
  assert.equal(live['brand-new-model'].coding, 99);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-bench-'));
  try {
    const file = path.join(dir, 'routing-benchmarks.json');
    fs.writeFileSync(file, JSON.stringify({
      models: {
        'my-new-release': { intelligence: 68, coding: 98, terminal: 72, frontend: 1850, speed: 'fast' },
      },
    }));
    const overrides = loadOverrideFile(file);
    const table = benchmarkTable([{ id: 'my-new-release-high', model: 'my-new-release', agent: 'gemini' }], { overrides, quotaPctFor: () => 95 });
    assert.match(table.table, /my-new-release-high \| .*98\.8|my-new-release-high \| .*98/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
