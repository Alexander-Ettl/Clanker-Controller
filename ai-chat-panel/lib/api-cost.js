'use strict';

// "API value": what the tokens Clanker Controller ran through the CLIs would have cost on the providers' pay-per-token
// APIs. A comparison, never a bill: the work runs on the user's subscriptions. Three sources, best first:
//   1. Claude Code's own cost figure (exact for its model, cache tiers and speed). It is a running total for the
//      process, so a turn's share is the rise since the last one (stream-engine.js does that).
//   2. A daily copy of LiteLLM's community price table, for models it lists (tracks price changes between releases).
//   3. The bundled table (api-prices.js), checked against the providers' pages.
// A model none of them prices counts as unpriced: it adds nothing rather than a guess.

const { PRICES, ALIASES, VERIFIED } = require('./api-prices.js');

const FEED_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const FEED_MAX_AGE = 24 * 60 * 60 * 1000;
const PER = 1e6;

/** The id a price table knows: lower case, without the CLI's effort or variant suffix ("gemini-3.8-flash-high"). */
function normalizeModel(model) {
  let id = String(model || '').trim().toLowerCase().replace(/\s+/g, '-');
  for (let i = 0; i < 3; i++) id = id.replace(/-(low|medium|high|xhigh|max|ultra|minimal|thinking|\d{8})$/, '');
  // The picker's label says "Claude Opus 5.5", Anthropic's ids say "claude-opus-5-5" (OpenAI and Google keep the dot).
  if (id.startsWith('claude-')) id = id.replace(/(\d)\.(\d)/g, '$1-$2');
  return ALIASES[id] || id;
}

/** Candidates for a model in a table, most specific first. */
const idsFor = (model) => [...new Set([
  String(model || '').toLowerCase().trim(),
  String(model || '').toLowerCase().trim().replace(/\s+/g, '-'),
  normalizeModel(model),
])].filter(Boolean);

/** One model's rates out of LiteLLM's table ($ per token there; per million here), or null. First-party entries only. */
function fromLitellm(table, model) {
  for (const id of idsFor(model)) {
    for (const key of [id, `gemini/${id}`, `anthropic/${id}`, `openai/${id}`]) {
      const entry = table?.[key];
      if (!entry || !Number.isFinite(entry.input_cost_per_token) || !Number.isFinite(entry.output_cost_per_token)) continue;
      const input = entry.input_cost_per_token * PER;
      const price = {
        input,
        cachedInput: Number.isFinite(entry.cache_read_input_token_cost) ? entry.cache_read_input_token_cost * PER : input,
        ...(Number.isFinite(entry.cache_creation_input_token_cost) ? { cacheWrite: entry.cache_creation_input_token_cost * PER } : {}),
        output: entry.output_cost_per_token * PER,
      };
      const tier = Object.keys(entry).map((k) => /^input_cost_per_token_above_(\d+)k_tokens$/.exec(k)).find(Boolean);
      if (tier) {
        const suffix = `_above_${tier[1]}k_tokens`;
        const longInput = entry[`input_cost_per_token${suffix}`] * PER;
        const ratio = longInput / input;
        price.longContext = {
          above: Number(tier[1]) * 1000,
          input: longInput,
          cachedInput: Number.isFinite(entry[`cache_read_input_token_cost${suffix}`]) ? entry[`cache_read_input_token_cost${suffix}`] * PER : price.cachedInput * ratio,
          ...(price.cacheWrite ? { cacheWrite: price.cacheWrite * ratio } : {}),
          output: Number.isFinite(entry[`output_cost_per_token${suffix}`]) ? entry[`output_cost_per_token${suffix}`] * PER : price.output * ratio,
        };
      }
      return price;
    }
  }
  return null;
}

/** The rates for `model`: the live table's when it has them, else the bundled ones, else null. */
function priceFor(model, live = {}) {
  for (const id of idsFor(model)) if (live[id]) return { ...live[id], source: 'live' };
  for (const id of idsFor(model)) if (PRICES[id]) return { ...PRICES[id], source: 'bundled' };
  return null;
}

/**
 * USD for one turn's tokens at `price`. usage: { fresh, cachedInput, cacheWrite, output } (output includes thinking).
 * A dated change (until/then) applies from the day after `until`; a long prompt is priced at the long-context rates.
 */
function costOf(price, usage, now = Date.now()) {
  if (!price || !usage) return null;
  let rates = price;
  if (price.until && now > Date.parse(`${price.until}T23:59:59Z`)) rates = { ...price, ...price.then };
  const n = (x) => (Number.isFinite(x) && x > 0 ? x : 0);
  if (typeof usage === 'number' || (typeof usage === 'object' && !('fresh' in usage) && (Number.isFinite(usage.tokens) || Number.isFinite(usage.total) || Number.isFinite(usage.totalTokens)))) {
    const total = typeof usage === 'number' ? usage : (usage.tokens ?? usage.total ?? usage.totalTokens);
    if (!(total > 0)) return null;
    // Agentic CLI turns (Codex, Gemini) run multi-step tool loops where prompt context is cached
    // on subsequent steps. Telemetry across real CLI rollout logs shows ~95% cached prompt, ~4% fresh, ~1% output.
    // Cumulative turn tokens must not trigger per-request longContext surcharges.
    const cachedInput = Math.round(total * 0.95);
    const freshInput = Math.round(total * 0.04);
    const output = total - cachedInput - freshInput;
    return (freshInput * rates.input + cachedInput * (rates.cachedInput ?? rates.input) + output * rates.output) / PER;
  }
  // Long-context rates are per request: the largest single prompt of the turn decides. A turn's summed tokens span many
  // requests, so without a peak (usage.peakPrompt) the standard rates apply.
  if (price.longContext && n(usage.peakPrompt) > price.longContext.above) rates = { ...rates, ...price.longContext };
  const usd = (n(usage.fresh) * rates.input + n(usage.cachedInput) * (rates.cachedInput ?? rates.input)
    + n(usage.cacheWrite) * (rates.cacheWrite ?? rates.input) + n(usage.output) * rates.output) / PER;
  return usd;
}

/** One turn's API value: Claude Code's own figure when it gave one, else the tokens at the model's rates; null if neither. */
function turnCost({ model, reportedUsd, usage, live, now }) {
  if (Number.isFinite(reportedUsd) && reportedUsd > 0) return { usd: reportedUsd, source: 'reported' };
  const price = priceFor(model, live);
  if (!price) return null;
  const usd = costOf(price, usage, now);
  return usd > 0 ? { usd, source: price.source } : null;
}

/**
 * A chat saved before chats kept their own total: its Claude replies carry the CLI's running figure. The rises add up
 * to the chat's total; a drop means a new process started from zero, so that reply's whole figure is new.
 */
function legacyChatCost(messages) {
  let total = 0;
  let previous = 0;
  for (const entry of messages || []) {
    if (entry?.role !== 'assistant' || !(entry.costUsd > 0)) continue;
    total += entry.costUsd >= previous ? entry.costUsd - previous : entry.costUsd;
    previous = entry.costUsd;
  }
  return total;
}

const LEDGER_VERSION = 4; // bump when pricing changes: the saved ledger is rebuilt from the chats on the next start
const emptyLedger = (now) => ({ v: LEDGER_VERSION, since: new Date(now).toISOString(), totalUsd: 0, turns: 0, unpriced: 0, byAgent: {}, byMonth: {} });

/** The ledger after one more turn (a new object). `usd` null: the turn could not be priced. */
function addTurn(ledger, { agent, usd }, now = Date.now()) {
  const next = ledger ? { ...ledger, v: LEDGER_VERSION, byAgent: { ...ledger.byAgent }, byMonth: { ...ledger.byMonth } } : emptyLedger(now);
  if (!(usd > 0)) { next.unpriced += 1; return next; }
  const month = new Date(now).toISOString().slice(0, 7);
  next.totalUsd += usd;
  next.turns += 1;
  next.byAgent[agent] = (next.byAgent[agent] || 0) + usd;
  next.byMonth[month] = (next.byMonth[month] || 0) + usd;
  return next;
}

/** Total pay-per-token API cost for a single chat, computed from its messages or cached apiCostUsd. */
function chatCost(chat, livePrices = {}, now = Date.now()) {
  if (Number.isFinite(chat?.apiCostUsd) && chat.apiCostUsd > 0) return chat.apiCostUsd;
  let total = 0;
  let prevClaude = 0;
  for (const entry of chat?.messages || []) {
    if (entry?.role !== 'assistant') continue;
    const agent = entry.agent || chat?.agent || 'claude';
    let usd = null;
    const tokens = Number.isFinite(entry.tokens) ? entry.tokens : entry.totalTokens;
    if (Number.isFinite(entry.apiCost?.usd) && entry.apiCost.usd > 0) {
      usd = entry.apiCost.usd;
    } else if (agent === 'claude' && Number.isFinite(entry.costUsd) && entry.costUsd > 0) {
      usd = entry.costUsd >= prevClaude ? entry.costUsd - prevClaude : entry.costUsd;
      prevClaude = entry.costUsd;
    } else if (entry.usage || tokens > 0) {
      const model = entry.apiCost?.model || entry.model || entry.modelLabel || chat?.modelId;
      const cost = turnCost({ model, usage: entry.usage || tokens, live: livePrices, now: Date.parse(entry.at || chat?.updatedAt) || now });
      usd = cost?.usd ?? null;
    }
    if (usd > 0) total += usd;
  }
  return total;
}

/**
 * Keeps the running total, the live price copy and its age. store/priceStore: { get(), set(value) } (globalState).
 * broadcast: posts to every chat window. livePrices(): whether fetching the table is allowed (a setting).
 */
class CostMeter {
  constructor({ store, priceStore, broadcast, fetchImpl = (...args) => fetch(...args), livePrices = () => true, now = () => Date.now() }) {
    Object.assign(this, { store, priceStore, broadcast, fetchImpl, livePrices, now });
    this.ledger = store.get() || null;
    this.live = priceStore.get() || { fetchedAt: 0, prices: {} };
  }

  turnCost(turn) { return turnCost({ ...turn, live: this.live.prices, now: this.now() }); }

  record(agent, cost) {
    this.ledger = addTurn(this.ledger, { agent, usd: cost?.usd ?? null }, this.now());
    this.store.set(this.ledger);
    this.broadcast(this.message());
  }

  /** Chats from before the meter: their totals, added once, so the figure starts with the history it can know. */
  seed(chats, { force = false } = {}) {
    if (this.ledger && !force) return;
    let ledger = emptyLedger(this.now());
    for (const chat of chats || []) {
      if (chat.createdAt && chat.createdAt < ledger.since) ledger.since = chat.createdAt;
      let prevClaude = 0;
      let chatTurnsAdded = 0;
      for (const entry of chat.messages || []) {
        if (entry?.role !== 'assistant') continue;
        const agent = entry.agent || chat.agent || 'claude';
        let usd = null;
        const tokens = Number.isFinite(entry.tokens) ? entry.tokens : entry.totalTokens;
        if (Number.isFinite(entry.apiCost?.usd) && entry.apiCost.usd > 0) {
          usd = entry.apiCost.usd;
        } else if (agent === 'claude' && Number.isFinite(entry.costUsd) && entry.costUsd > 0) {
          usd = entry.costUsd >= prevClaude ? entry.costUsd - prevClaude : entry.costUsd;
          prevClaude = entry.costUsd;
        } else if (entry.usage || tokens > 0) {
          const model = entry.apiCost?.model || entry.model || entry.modelLabel || chat.modelId;
          const cost = turnCost({ model, usage: entry.usage || tokens, live: this.live.prices, now: Date.parse(entry.at || chat.updatedAt) || this.now() });
          usd = cost?.usd ?? null;
        }
        const at = Date.parse(entry.at || chat.updatedAt) || this.now();
        ledger = addTurn(ledger, { agent, usd }, at);
        if (usd > 0) chatTurnsAdded++;
      }
      if (!chatTurnsAdded && chat.apiCostUsd > 0) {
        ledger = addTurn(ledger, { agent: chat.agent || 'claude', usd: chat.apiCostUsd }, Date.parse(chat.updatedAt) || this.now());
      }
    }
    this.ledger = ledger;
    this.store.set(ledger);
    this.broadcast(this.message());
  }

  message() {
    const ledger = this.ledger || emptyLedger(this.now());
    const month = new Date(this.now()).toISOString().slice(0, 7);
    const byAgent = { claude: 0, codex: 0, gemini: 0, ...ledger.byAgent };
    return {
      type: 'apiValue', totalUsd: ledger.totalUsd, monthUsd: ledger.byMonth[month] || 0, byAgent, since: ledger.since,
      unpriced: ledger.unpriced, prices: { verified: VERIFIED, liveAt: this.live.fetchedAt || null },
    };
  }

  /** Refreshes the live copy for these models when it is a day old (or misses one). Never throws. */
  async refreshPrices(models) {
    const wanted = [...new Set(models.flatMap(idsFor))];
    const fresh = this.now() - (this.live.fetchedAt || 0) < FEED_MAX_AGE;
    if (!this.livePrices() || (fresh && wanted.every((id) => id in this.live.prices || PRICES[id]))) return;
    try {
      const res = await this.fetchImpl(FEED_URL, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) return;
      const table = await res.json();
      const prices = {};
      for (const id of wanted) { const price = fromLitellm(table, id); if (price) prices[id] = price; }
      this.live = { fetchedAt: this.now(), prices };
      this.priceStore.set(this.live);
      this.broadcast(this.message());
    } catch { /* offline or blocked: the bundled table stands */ }
  }
}

module.exports = { LEDGER_VERSION, FEED_URL, normalizeModel, fromLitellm, priceFor, costOf, turnCost, legacyChatCost, chatCost, addTurn, CostMeter };
