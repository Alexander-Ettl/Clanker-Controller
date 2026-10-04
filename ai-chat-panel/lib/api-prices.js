'use strict';

// Pay-per-token API prices, USD per million tokens, for the "API value" comparison (api-cost.js). The fallback only:
// at runtime a daily copy of LiteLLM's community price table wins when it has the model (it tracks price changes
// faster than a release can), and Claude Code's own cost figure wins over both for Claude turns.
//
// Checked 2026-10-01 against the providers' own pages:
//   Anthropic  https://platform.claude.com/docs/en/about-claude/pricing
//   OpenAI     https://developers.openai.com/api/docs/pricing  (short context <= 272K input; above it, the long rates)
//   Google     https://ai.google.dev/gemini-api/docs/pricing  (Flash: introductory rates through 2026-12-31, then double)
// Entries marked `feed` were not on the provider page fetched that day and come from LiteLLM's table only.
//
// Fields: input (fresh input), cachedInput (cache reads), cacheWrite (when the provider bills it), output (thinking and
// reasoning included). longContext: rates for a request whose prompt is above `above` tokens. until/then: a dated change.

const VERIFIED = '2026-10-01';

const claude = (input, cachedInput, cacheWrite, output) => ({ input, cachedInput, cacheWrite, output });
const openai = (input, cachedInput, cacheWrite, output, long) => ({ input, cachedInput, cacheWrite, output, ...(long ? { longContext: { above: 272000, ...long } } : {}) });
const FLASH = { input: 0.75, cachedInput: 0.075, output: 3.75, until: '2026-12-31', then: { input: 1.5, cachedInput: 0.15, output: 7.5 } };

const PRICES = {
  // Anthropic
  'claude-fable-5-1': claude(10, 0.25, 12.5, 50),
  'claude-fable-5': claude(10, 1, 12.5, 50),
  'claude-opus-5-5': claude(4, 0.2, 5, 20),
  'claude-opus-5': claude(5, 0.5, 6.25, 25),
  'claude-opus-4-8': claude(5, 0.5, 6.25, 25),
  'claude-opus-4-7': claude(5, 0.5, 6.25, 25),
  'claude-opus-4-6': claude(5, 0.5, 6.25, 25),
  'claude-opus-4-5': claude(5, 0.5, 6.25, 25),
  'claude-sonnet-5-5': claude(2, 0.2, 2.5, 10),
  'claude-sonnet-5': claude(2, 0.2, 2.5, 10),
  'claude-sonnet-4-6': claude(3, 0.3, 3.75, 15),
  'claude-sonnet-4-5': claude(3, 0.3, 3.75, 15),
  'claude-haiku-4-5': claude(1, 0.1, 1.25, 5),
  // OpenAI (Codex)
  'gpt-6.1-sol': openai(2, 0.1, 2.5, 10, { input: 4, cachedInput: 0.2, cacheWrite: 5, output: 15 }),
  'gpt-6-astra': openai(10, 1, 12.5, 50, { input: 20, cachedInput: 2, cacheWrite: 25, output: 75 }),
  'gpt-6-luna': openai(0.1, 0.01, 0.125, 0.5, { input: 0.2, cachedInput: 0.02, cacheWrite: 0.25, output: 0.75 }),
  'gpt-6-sol': { ...openai(2, 0.2, 2.5, 10, { input: 4, cachedInput: 0.4, cacheWrite: 5, output: 15 }), feed: true },
  'gpt-5.6-sol': openai(4, 0.4, 5, 20, { input: 8, cachedInput: 0.8, cacheWrite: 10, output: 30 }),
  'gpt-5.6-terra': openai(2, 0.2, 2.5, 12, { input: 4, cachedInput: 0.4, cacheWrite: 5, output: 18 }),
  'gpt-5.6-luna': openai(0.2, 0.02, 0.25, 1.2, { input: 0.4, cachedInput: 0.04, cacheWrite: 0.5, output: 1.8 }),
  'gpt-5.5': { ...openai(5, 0.5, undefined, 30), feed: true },
  // Google (Antigravity)
  'gemini-3.8-flash': FLASH,
  'gemini-3.7-flash': FLASH,
  'gemini-3.6-flash': FLASH,
  'gemini-3.1-pro': { input: 2, cachedInput: 0.2, output: 12, longContext: { above: 200000, input: 4, cachedInput: 0.4, output: 18 } },
  'gemini-2.5-pro': { input: 1.25, cachedInput: 0.3125, output: 5, longContext: { above: 200000, input: 2.5, cachedInput: 0.625, output: 10 } },
  'gemini-2.5-flash': { input: 0.075, cachedInput: 0.01875, output: 0.3 },
  'gemini-2.0-flash': { input: 0.1, cachedInput: 0.025, output: 0.4 },
};

// Names a CLI uses for a model listed above under another name.
const ALIASES = {
  'gemini-3.1-pro-preview': 'gemini-3.1-pro',
  'gemini-flash': 'gemini-3.8-flash',
  'gemini-pro': 'gemini-3.1-pro',
  'gpt-reserve': 'gpt-6.1-sol',
  'codex-auto-review': 'gpt-5.6-sol',
  'gpt-sol': 'gpt-6.1-sol',
  'gpt-terra': 'gpt-5.6-terra',
  'gpt-astra': 'gpt-6-astra',
  'gpt-luna': 'gpt-6-luna',
};

module.exports = { VERIFIED, PRICES, ALIASES };

