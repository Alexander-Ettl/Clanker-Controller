'use strict';

// "API value": what the tokens Clanker Controller ran through the CLIs would have cost on the providers' pay-per-token
// APIs. A comparison, never a bill: the work runs on the user's subscriptions. A turn's token counts are priced at, best first:
//   1. A daily copy of LiteLLM's community price table, for models it lists (tracks price changes between releases).
//   2. The bundled table (api-prices.js), checked against the providers' pages.
// Claude Code's own cost figure is only the fallback for a turn without token counts: its built-in table prices Sonnet 5
// like Sonnet 4 (about 1.8x too high for our cache-heavy turns, measured against its own logs; anthropics issue 87855).
// A model none of them prices counts as unpriced: it adds nothing rather than a guess.

const { PRICES, ALIASES, VERIFIED } = require('./api-prices.js');

const FEED_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const FEED_MAX_AGE = 24 * 60 * 60 * 1000;
const PER = 1e6;
// Claude Code's own cost figure over the same turns' tokens at Anthropic's published prices: 343 / 192 for 479 Sonnet 5.5
// turns matched against its session logs (2026-11-15). Applied to the figures saved before turns were priced from tokens.
const CLI_FIGURE_FACTOR = 0.56;

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
        ...(Number.isFinite(entry.cache_creation_input_token_cost_above_1hr) ? { cacheWrite1h: entry.cache_creation_input_token_cost_above_1hr * PER } : {}),
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
 * USD for one turn's tokens at `price`. usage: { fresh, cachedInput, cacheWrite, cacheWrite1h (part of cacheWrite), output } (output includes thinking).
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
    + (n(usage.cacheWrite) - n(usage.cacheWrite1h)) * (rates.cacheWrite ?? rates.input)
    + n(usage.cacheWrite1h) * (rates.cacheWrite1h ?? rates.cacheWrite ?? rates.input) + n(usage.output) * rates.output) / PER;
  return usd;
}

/** One turn's API value: the tokens at the model's rates; Claude Code's own (inflated, see above) figure only without them. */
function turnCost({ model, reportedUsd, usage, live, now }) {
  const price = priceFor(model, live);
  const usd = price ? costOf(price, usage, now) : null;
  if (usd > 0) return { usd, source: price.source };
  if (Number.isFinite(reportedUsd) && reportedUsd > 0) return { usd: reportedUsd * CLI_FIGURE_FACTOR, source: 'reported' };
  return null;
}

const LEDGER_VERSION = 5; // bump when pricing changes: the saved ledger is rebuilt from the chats on the next start
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

/**
 * A chat's replies as { agent, usd (null: unpriced), at }. A saved figure from Claude Code ("reported", or a running
 * costUsd whose rises are the turns) is corrected by CLI_FIGURE_FACTOR; everything else is priced from tokens.
 */
function chatTurns(chat, live = {}, now = Date.now()) {
  const turns = [];
  let prevClaude = 0;
  for (const entry of chat?.messages || []) {
    if (entry?.role !== 'assistant') continue;
    const agent = entry.agent || chat?.agent || 'claude';
    const at = Date.parse(entry.at || chat?.updatedAt) || now;
    let usd = null;
    const tokens = Number.isFinite(entry.tokens) ? entry.tokens : entry.totalTokens;
    if (Number.isFinite(entry.apiCost?.usd) && entry.apiCost.usd > 0) {
      usd = entry.apiCost.usd * (entry.apiCost.source === 'reported' ? CLI_FIGURE_FACTOR : 1);
    } else if (agent === 'claude' && Number.isFinite(entry.costUsd) && entry.costUsd > 0) {
      usd = (entry.costUsd >= prevClaude ? entry.costUsd - prevClaude : entry.costUsd) * CLI_FIGURE_FACTOR;
      prevClaude = entry.costUsd;
    } else if (entry.usage || tokens > 0) {
      const model = entry.apiCost?.model || entry.model || entry.modelLabel || chat?.modelId;
      usd = turnCost({ model, usage: entry.usage || tokens, live, now: at })?.usd ?? null;
    }
    turns.push({ agent, usd, at });
  }
  return turns;
}

/** A chat's total from its replies (current prices and corrections), never from the figure saved with it. */
function chatTotal(chat, live = {}, now = Date.now()) {
  const total = chatTurns(chat, live, now).reduce((sum, turn) => sum + (turn.usd > 0 ? turn.usd : 0), 0);
  // Replies gone (a trimmed chat) leave only the saved figure, which for Claude chats came from the inflated CLI total.
  return total || (chat?.apiCostUsd > 0 ? chat.apiCostUsd * ((chat.agent || 'claude') === 'claude' ? CLI_FIGURE_FACTOR : 1) : 0);
}

/** Total pay-per-token API cost for a single chat: the saved running figure when it is current, else rebuilt from the replies. */
function chatCost(chat, livePrices = {}, now = Date.now()) {
  if (chat?.apiCostV === LEDGER_VERSION && Number.isFinite(chat.apiCostUsd) && chat.apiCostUsd > 0) return chat.apiCostUsd;
  return chatTotal(chat, livePrices, now);
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
      const turns = chatTurns(chat, this.live.prices, this.now());
      for (const turn of turns) ledger = addTurn(ledger, turn, turn.at);
      if (!turns.some((turn) => turn.usd > 0) && chat.apiCostUsd > 0) {
        ledger = addTurn(ledger, { agent: chat.agent || 'claude', usd: chatTotal(chat) }, Date.parse(chat.updatedAt) || this.now());
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

module.exports = { LEDGER_VERSION, FEED_URL, normalizeModel, fromLitellm, priceFor, costOf, turnCost, chatTurns, chatTotal, chatCost, addTurn, CostMeter };
