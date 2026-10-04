'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeModel, fromLitellm, priceFor, costOf, turnCost, legacyChatCost, chatCost, addTurn, CostMeter, LEDGER_VERSION } = require('../lib/api-cost.js');
const { formatUsd, formatRange } = require('../media/api-value.js');

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const M = 1e6;
const OCT = Date.parse('2026-10-01T12:00:00Z');

test('normalizeModel: effort and variant suffixes go, aliases resolve', () => {
  assert.equal(normalizeModel('gemini-3.8-flash-high'), 'gemini-3.8-flash');
  assert.equal(normalizeModel('Gemini 3.8 Flash High'), 'gemini-3.8-flash');
  assert.equal(normalizeModel('GPT 6.1 Sol Medium'), 'gpt-6.1-sol');
  assert.equal(normalizeModel('claude-opus-4-6-thinking'), 'claude-opus-4-6');
  assert.equal(normalizeModel('Claude-Opus-5-5'), 'claude-opus-5-5');
  assert.equal(normalizeModel('gemini-3.1-pro-high'), 'gemini-3.1-pro');
  assert.equal(normalizeModel('gemini-3.1-pro-preview'), 'gemini-3.1-pro');
  assert.equal(normalizeModel('gpt-6.1-sol'), 'gpt-6.1-sol');
  assert.equal(normalizeModel('gpt-reserve'), 'gpt-6.1-sol');
  assert.equal(normalizeModel('codex-auto-review'), 'gpt-5.6-sol');
});

test('costOf: each kind of token at its own rate (Claude Sonnet 5.5: 2 / 0.20 / 2.50 / 10 per MTok)', () => {
  const price = priceFor('claude-sonnet-5-5');
  close(costOf(price, { fresh: M, cachedInput: 0, cacheWrite: 0, output: 0 }, OCT), 2);
  close(costOf(price, { fresh: 0, cachedInput: M, cacheWrite: M, output: M }, OCT), 0.2 + 2.5 + 10);
});

test('costOf: long-context rates follow the largest single prompt, not the turn total (GPT-6.1 Sol 2/10 -> 4/15)', () => {
  const price = priceFor('gpt-6.1-sol');
  close(costOf(price, { fresh: 300000, output: 10000 }, OCT), (300000 * 2 + 10000 * 10) / M); // many small requests
  close(costOf(price, { fresh: 300000, output: 10000, peakPrompt: 200000 }, OCT), (300000 * 2 + 10000 * 10) / M);
  close(costOf(price, { fresh: 300000, output: 10000, peakPrompt: 300000 }, OCT), (300000 * 4 + 10000 * 15) / M);
});

test('normalizeModel: the picker label of a Claude model reaches its dashed id', () => {
  assert.equal(normalizeModel('Claude Opus 5.5 Medium'), 'claude-opus-5-5');
  assert.equal(normalizeModel('Claude Sonnet 5.5 High'), 'claude-sonnet-5-5');
  assert.ok(priceFor('Claude Opus 5.5 Medium'));
});

test('costOf: Gemini Flash introductory rates end after 2026-12-31', () => {
  const price = priceFor('gemini-3.8-flash-high');
  close(costOf(price, { fresh: M, output: M }, Date.parse('2026-12-31T20:00:00Z')), 0.75 + 3.75);
  close(costOf(price, { fresh: M, output: M }, Date.parse('2027-01-01T08:00:00Z')), 1.5 + 7.5);
});

test('turnCost: Claude Code’s own figure wins; unknown models are unpriced, not guessed', () => {
  assert.deepEqual(turnCost({ model: 'claude-opus-5-5', reportedUsd: 0.42, usage: { fresh: 10, output: 10 } }), { usd: 0.42, source: 'reported' });
  assert.equal(turnCost({ model: 'some-new-model', usage: { fresh: 1000, output: 1000 } }), null);
  assert.equal(turnCost({ model: 'gpt-6-luna', usage: { fresh: 0, output: 0 } }), null);
  assert.equal(turnCost({ model: 'gpt-6-luna', usage: { fresh: M, output: 0 } }).source, 'bundled');
});

test('fromLitellm / priceFor: the live table converts per-token rates and wins over the bundled table', () => {
  const table = {
    'gpt-6.1-sol': { input_cost_per_token: 3e-6, output_cost_per_token: 12e-6, cache_read_input_token_cost: 0.3e-6, input_cost_per_token_above_272k_tokens: 6e-6, output_cost_per_token_above_272k_tokens: 18e-6 },
    'gemini/gemini-3.8-flash': { input_cost_per_token: 0.75e-6, output_cost_per_token: 3.75e-6, cache_read_input_token_cost: 0.075e-6 },
    'azure/only-elsewhere': { input_cost_per_token: 1e-6, output_cost_per_token: 1e-6 },
  };
  const sol = fromLitellm(table, 'gpt-6.1-sol');
  close(sol.input, 3); close(sol.output, 12); close(sol.cachedInput, 0.3);
  assert.equal(sol.longContext.above, 272000); close(sol.longContext.input, 6); close(sol.longContext.output, 18);
  close(fromLitellm(table, 'gemini-3.8-flash-high').input, 0.75);
  assert.equal(fromLitellm(table, 'only-elsewhere'), null);
  const live = { 'gpt-6.1-sol': sol };
  assert.equal(priceFor('gpt-6.1-sol', live).source, 'live');
  assert.equal(priceFor('gpt-6-astra', live).source, 'bundled');
});

test('legacyChatCost: running totals become the chat total; a drop is a fresh process', () => {
  const reply = (costUsd) => ({ role: 'assistant', costUsd });
  close(legacyChatCost([reply(1), { role: 'user' }, reply(2.5), reply(4)]), 4);
  close(legacyChatCost([reply(3), reply(0.5), reply(1)]), 3 + 0.5 + 0.5);
  assert.equal(legacyChatCost([{ role: 'assistant' }]), 0);
});

test('addTurn: totals by provider and month; unpriced turns are counted, not added', () => {
  let ledger = addTurn(null, { agent: 'claude', usd: 1.5 }, OCT);
  ledger = addTurn(ledger, { agent: 'codex', usd: 0.5 }, OCT);
  ledger = addTurn(ledger, { agent: 'gemini', usd: null }, OCT);
  close(ledger.totalUsd, 2); assert.equal(ledger.turns, 2); assert.equal(ledger.unpriced, 1);
  assert.deepEqual(ledger.byAgent, { claude: 1.5, codex: 0.5 });
  assert.deepEqual(ledger.byMonth, { '2026-10': 2 });
});

test('formatUsd: short for the narrow sidebar', () => {
  assert.equal(formatUsd(0), '$0');
  assert.equal(formatUsd(0.004), '<$0.01');
  assert.equal(formatUsd(19.876), '$19.88');
  assert.equal(formatUsd(184.4), '$184');
  assert.equal(formatUsd(1284), '$1.3k');
  assert.equal(formatUsd(12500), '$13k');
});

test('formatRange: the estimate plus and minus 20%', () => {
  assert.equal(formatRange(1000), '$800 – $1.2k');
  assert.equal(formatRange(56.43), '$45.14 – $67.72');
});

test('costOf: prices total token count with 95/4/1 prompt cache blend', () => {
  const price = priceFor('gemini-3.8-flash');
  // 1M tokens: 40k fresh * 0.75 + 950k cached * 0.075 + 10k output * 3.75 = 0.03 + 0.07125 + 0.0375 = 0.13875
  close(costOf(price, M, OCT), 0.13875);
  close(costOf(price, { tokens: M }, OCT), 0.13875);
});

test('CostMeter.seed: calculates multi-agent totals from chat history (Claude, Codex, Gemini)', () => {
  let storeVal = null;
  let broadcastMsg = null;
  const store = { get: () => storeVal, set: (v) => { storeVal = v; } };
  const priceStore = { get: () => null, set: () => {} };
  const meter = new CostMeter({ store, priceStore, broadcast: (m) => { broadcastMsg = m; }, now: () => OCT });

  const chats = [
    {
      createdAt: '2026-09-25T10:00:00Z',
      updatedAt: '2026-10-01T10:00:00Z',
      messages: [
        { role: 'assistant', agent: 'claude', costUsd: 10 },
        { role: 'assistant', agent: 'codex', modelLabel: 'GPT 6.1 Sol Medium', tokens: 1000000 },
        { role: 'assistant', agent: 'gemini', modelLabel: 'Gemini 3.8 Flash High', totalTokens: 1000000 },
      ],
    },
  ];

  meter.seed(chats);
  const msg = meter.message();
  assert.equal(msg.type, 'apiValue');
  assert.equal(meter.ledger.v, LEDGER_VERSION);
  assert.ok(msg.byAgent.claude >= 10);
  assert.ok(msg.byAgent.codex > 0);
  assert.ok(msg.byAgent.gemini > 0);
  assert.ok(msg.totalUsd > 10);
  assert.deepEqual(broadcastMsg, msg);
});

test('chatCost: computes API cost of a chat from assistant turns', () => {
  const chat = {
    agent: 'codex',
    modelId: 'gpt-6.1-sol',
    messages: [
      { role: 'user', text: 'hello' },
      { role: 'assistant', agent: 'codex', modelLabel: 'GPT 6.1 Sol Medium', tokens: 1000000 },
    ],
  };
  const cost = chatCost(chat, {}, OCT);
  assert.ok(cost > 0);
});

