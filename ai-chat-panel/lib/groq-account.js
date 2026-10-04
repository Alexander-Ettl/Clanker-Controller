'use strict';

// The Groq account behind dictation: where its API key lives, and how much of the day's allowance is used. Groq has no
// third-party sign-in and no usage endpoint for a key, so "logging in" is saving a key (kept in the editor's secret
// storage, never in a file) and usage is read from what Groq itself reports: every response carries the day's request
// limit and what is left of it (x-ratelimit-*-requests). Those are remembered per kind of call, next to a count of the
// requests made from here today.

const KEY_NAME = 'groqApiKey';
const MODELS_URL = 'https://api.groq.com/openai/v1/models';
const UNITS = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };

/** "2m59.56s", "7.66s", "1d2h3m4s", "250ms" as milliseconds; null if it is none of those. */
function parseDuration(text) {
  let ms = 0;
  let matched = false;
  for (const part of String(text ?? '').matchAll(/(\d+(?:\.\d+)?)(ms|d|h|m|s)/g)) { matched = true; ms += Number(part[1]) * UNITS[part[2]]; }
  return matched ? Math.round(ms) : null;
}

/** { limit, remaining, resetMs } from a response's headers (anything with get(name)), or null when Groq sent no request limit. */
function parseRateHeaders(headers) {
  const number = (name) => { const raw = headers.get(name); return raw === null || raw === '' || !Number.isFinite(Number(raw)) ? null : Number(raw); };
  const limit = number('x-ratelimit-limit-requests');
  const remaining = number('x-ratelimit-remaining-requests');
  if (limit === null || remaining === null) return null;
  return { limit, remaining, resetMs: parseDuration(headers.get('x-ratelimit-reset-requests')) };
}

const dayOf = (time) => new Date(time).toISOString().slice(0, 10); // Groq's day is UTC

class GroqAccount {
  /** secrets: the editor's SecretStorage. store: { get(), set(value) }. loadEnv(): reads the voice router's .env into process.env. */
  constructor({ secrets, store, env = process.env, loadEnv = () => {}, fetchImpl = (...args) => fetch(...args), now = () => Date.now(), onChange = () => {} }) {
    Object.assign(this, { secrets, store, env, loadEnv, fetchImpl, now, onChange });
    this.usage = store.get() || { day: dayOf(now()), calls: 0, limits: {} };
    this.fromSecret = false;
  }

  /** Puts the saved key where the voice router reads it. */
  async init() {
    const key = await this.secrets.get(KEY_NAME);
    this.fromSecret = Boolean(key);
    if (key) this.env.GROQ_API_KEY = key;
  }

  /** Hands the voice router's Groq client this account's counter. */
  attach(groqClient) { groqClient.setRateLimitListener((event) => this.record(event)); }

  record({ kind, headers }) {
    const now = this.now();
    if (this.usage.day !== dayOf(now)) this.usage = { ...this.usage, day: dayOf(now), calls: 0 };
    this.usage.calls += 1;
    const rate = parseRateHeaders(headers);
    if (rate) this.usage.limits = { ...this.usage.limits, [kind]: { limit: rate.limit, remaining: rate.remaining, at: now, resetsAt: rate.resetMs === null ? null : now + rate.resetMs } };
    this.store.set(this.usage);
    this.onChange();
  }

  /** Saves a key after Groq accepts it. { ok: true } or { ok: false, error }. */
  async save(key) {
    const trimmed = String(key || '').trim();
    if (!trimmed) return { ok: false, error: 'Paste a key first.' };
    try {
      const response = await this.fetchImpl(MODELS_URL, { headers: { Authorization: `Bearer ${trimmed}` }, signal: AbortSignal.timeout(15000) });
      if (response.status === 401 || response.status === 403) return { ok: false, error: 'Groq rejected this key.' };
      if (!response.ok) return { ok: false, error: `Groq answered ${response.status}.` };
    } catch (error) {
      return { ok: false, error: `Could not reach Groq (${error.message}).` };
    }
    await this.secrets.store(KEY_NAME, trimmed);
    this.env.GROQ_API_KEY = trimmed;
    this.fromSecret = true;
    this.onChange();
    return { ok: true };
  }

  /** Forgets the saved key; a key in tools/voice-router/.env takes over again if there is one. */
  async clear() {
    await this.secrets.delete(KEY_NAME);
    if (this.fromSecret) delete this.env.GROQ_API_KEY;
    this.fromSecret = false;
    this.loadEnv();
    this.onChange();
  }

  /** Makes Groq report the current limits with one tiny request. probe: groq-client's probeRateLimits. */
  async check(probe) {
    try { await probe(); return { ok: true }; } catch (error) { return { ok: false, error: error.message }; }
  }

  snapshot() {
    this.loadEnv();
    const key = this.env.GROQ_API_KEY || '';
    const now = this.now();
    const limits = {};
    for (const [kind, seen] of Object.entries(this.usage.limits || {})) {
      const reset = seen.resetsAt !== null && now >= seen.resetsAt; // the day rolled over since: it is whole again
      limits[kind] = { limit: seen.limit, remaining: reset ? seen.limit : seen.remaining, resetsAt: reset ? null : seen.resetsAt, at: seen.at };
    }
    return {
      source: !key ? null : this.fromSecret ? 'account' : 'env',
      masked: key ? `${key.slice(0, 4)}…${key.slice(-4)}` : '',
      today: { day: dayOf(now), calls: this.usage.day === dayOf(now) ? this.usage.calls : 0 },
      limits,
    };
  }
}

module.exports = { KEY_NAME, parseDuration, parseRateHeaders, GroqAccount };
