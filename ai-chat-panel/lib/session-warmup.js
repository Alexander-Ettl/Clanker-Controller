'use strict';

// Keeps each provider's 5-hour usage window rolling in the background. A window only begins with the first request, so one
// tiny "respond with 1" to the cheapest model, sent as soon as the previous window is over, means a window is nearly always
// already part-way through when work begins. Once per window per provider, and only when no window is running and no
// prompt is queued for that provider's usage reset (that prompt starts the next window by itself, so the ping would be wasted).
// Never for a CLI billed per token through an API key: there a ping is real money and no window exists to start.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run, shimmed } = require('./loop-exec.js');
const { cliTelemetry } = require('./cli-telemetry.js');
const { fromRateLimitEvent } = require('./claude-usage.js');
const { usageTotal } = require('./investigation-runner.js');

const PROMPT = 'respond with 1';
const WINDOW_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const TICK_MS = 60 * 1000;
const TIMEOUT_MS = 90 * 1000;
const CHEAP = ['nano', 'mini', 'haiku', 'lite', 'flash', 'spark'].map((word) => new RegExp(`(?<![a-z])${word}(?![a-z])`, 'i')); // whole words: "Gemini" is not "mini"
const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

const effortOf = (entry) => entry.effort || /(?:^|[-\s])(none|minimal|low|medium|high|xhigh|max|ultra)$/i.exec(entry.model || entry.id || '')?.[1]?.toLowerCase() || null;
const effortRank = (entry) => { const rank = EFFORT_ORDER.indexOf(effortOf(entry)); return rank < 0 ? EFFORT_ORDER.indexOf('medium') : rank; };
const tierOf = (entry) => { const tier = CHEAP.findIndex((pattern) => pattern.test(`${entry.model} ${entry.label || ''}`)); return tier < 0 ? CHEAP.length : tier; };
const isArgon = (entry) => entry?.brand === 'antigravityArgon' || /argon/i.test(entry?.model || '');

/** The least expensive model of one provider (or sub-pool `brand`): a small family first, then the lowest reasoning effort, then the newest. */
function cheapestModel(models, agent, brand) {
  return models.filter((entry) => entry?.agent === agent && entry.model && (brand === 'antigravityArgon' ? isArgon(entry) : brand ? entry.brand === brand : !isArgon(entry)))
    .sort((a, b) => tierOf(a) - tierOf(b) || effortRank(a) - effortRank(b) || String(b.model).localeCompare(String(a.model), 'en', { numeric: true }))[0] || null;
}

/** The command for one provider. `lean` strips what the CLI would add around the prompt (tools, hooks, project settings). */
function commandFor(agent, entry, binary, { lean = true } = {}) {
  const { command, args, env } = shimmed(binary, []);
  if (agent === 'claude') {
    return { command, env: { ...env, ...cliTelemetry(agent).env }, input: `${PROMPT}\n`, args: [...args, '-p', '--output-format', 'stream-json', '--verbose', '--model', entry.model, ...(entry.effort ? ['--effort', entry.effort] : []),
      ...(lean ? ['--tools', '', '--system-prompt', 'Reply with only the number the user asks for.', '--no-session-persistence', '--disable-slash-commands', '--setting-sources', 'local', '--strict-mcp-config'] : [])] };
  }
  if (agent === 'codex') {
    // No --ephemeral: Codex's quota is read from its session logs (quota-sources.js), so a ping that leaves none starts the
    // window without Clanker ever seeing it, and the ring keeps showing no window running.
    return { command, env, input: `${PROMPT}\n`, args: [...args, 'exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', ...cliTelemetry(agent).args, '--model', entry.model, ...(entry.effort ? ['-c', `model_reasoning_effort="${entry.effort}"`] : []), '-'] };
  }
  return { command, env, input: JSON.stringify({ event: 'user', message: { content: PROMPT } }) + '\n', args: [...args, '--model', entry.model, '--mode', 'plan', '--sandbox', '--disable-slash-commands',
    '--input-format', 'stream-json', '--output-format', 'stream-json', '--print-timeout', `${TIMEOUT_MS / 1000}s`] };
}

/** Tokens the ping used and, for Claude, the usage windows its rate-limit event reports. */
function readOutput(output) {
  let tokens = null, windows = null, reply = '';
  for (const line of String(output).split('\n')) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    const usage = event?.usage || event?.result?.usage || event?.message?.usage;
    const total = usage && usageTotal(usage);
    if (total != null) tokens = Math.max(tokens ?? 0, total);
    windows = fromRateLimitEvent(event) || windows;
    if (typeof event?.result === 'string') reply = event.result;
  }
  return { tokens, windows, reply };
}

// A CLI can exit cleanly after emitting only startup events, or report a failed turn in JSON.
// Require a completed answer before waiting another five hours.
function completedReply(output) {
  let complete = false, reply = '', error = '';
  for (const line of String(output).split('\n')) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (event.is_error || event.type === 'error' || event.type === 'turn.failed' || event.result?.status === 'ERROR') {
      error = event.error?.message || event.error || event.result?.error || event.result || 'CLI reported a failed turn';
    }
    if (event.type === 'result' && typeof event.result === 'string') { complete = true; reply = event.result; }
    if (event.event === 'result') { complete = true; reply = event.result?.response || ''; }
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') reply = event.item.text || '';
    if (event.type === 'turn.completed') complete = true;
  }
  return { ok: complete && Boolean(reply.trim()) && !error, error: String(error) };
}

class SessionWarmup {
  /**
   * getConfig() -> { enabled }                      models() -> catalog entries          agents() -> provider ids to use
   * locate(agent) -> binary path or ''             hasScheduled(agent) -> true when a prompt waits for that provider's reset
   * subscription(agent) -> false when that CLI is billed per token (API key)
   * readQuotas() -> shaped quotas        record(agent, windows) learns a reading
   * store { get, set } keeps { [agent]: result with `next`, the time it is due again }   execute(command, args, options) runs a child (swapped in tests)
   */
  constructor({ getConfig, models, agents, locate, hasScheduled = async () => false, subscription = () => true, readQuotas, record = () => {}, store, execute = run, now = () => new Date(), onChange = () => {}, tickMs = TICK_MS, tmpdir = os.tmpdir() }) {
    Object.assign(this, { getConfig, models, agents, locate, hasScheduled, subscription, readQuotas, record, store, execute, now, onChange, tickMs, tmpdir });
    this.busy = false; this.timer = null; this.disposed = false;
  }

  start() {
    this.timer = setInterval(() => void this.tick(), this.tickMs); this.timer.unref?.();
    setTimeout(() => void this.tick(), 15000).unref?.(); // after model discovery had a chance
  }

  dispose() { this.disposed = true; clearInterval(this.timer); }

  snapshot() { return { enabled: Boolean(this.getConfig().enabled), last: this.store.get() || {} }; }

  /** Pings every provider that is due; resolves the agents it pinged. Never throws. */
  async tick() {
    if (this.busy || this.disposed || !this.getConfig().enabled) return [];
    const now = this.now().getTime();
    this.busy = true;
    const pinged = [];
    try {
      const state = { ...(this.store.get() || {}) };
      const models = this.models();
      const targets = this.agents().flatMap((agent) => [
        { key: agent, agent, entry: cheapestModel(models, agent), windowMs: WINDOW_MS },
        ...(agent === 'gemini' ? [{ key: 'antigravityArgon', agent, entry: cheapestModel(models, agent, 'antigravityArgon'), windowMs: WEEK_MS }] : []),
      ]);
      const wanted = [];
      for (const target of targets.filter((item) => item.entry && now >= (state[item.key]?.next ?? 0))) {
        const binary = this.locate(target.agent);
        if (binary && this.subscription(target.agent) && !(await this.hasScheduled(target.agent).catch(() => false))) wanted.push({ ...target, binary }); // else look again next tick
      }
      if (!wanted.length) return [];
      const quotas = await this.readQuotas().catch(() => ({}));
      for (const { key, agent, entry, binary, windowMs } of wanted) {
        if (key === 'antigravityArgon' && quotas?.gemini && !quotas?.antigravityArgon) continue; // Ultra shares the Gemini pool
        const window = quotas?.[key];
        if (window && typeof window.resetsAt === 'number' && window.resetsAt * 1000 > now) {
          state[key] = { status: 'running', at: now, next: window.resetsAt * 1000, label: entry.label }; // look again when it is over
          continue;
        }
        const retry = state[key]?.status === 'failed' && state[key].attempts < MAX_ATTEMPTS;
        const attempts = retry ? state[key].attempts + 1 : 1;
        const result = await this.ping(agent, entry, binary);
        state[key] = { attempts, ...result, next: result.at + (result.status === 'failed' && attempts < MAX_ATTEMPTS ? RETRY_MS : windowMs) };
        pinged.push(key);
        await this.store.set({ ...state }); this.onChange();
      }
      await this.store.set({ ...state }); this.onChange();
    } finally { this.busy = false; }
    return pinged;
  }

  /** One ping. Falls back to the plain command once if the lean flags were refused by this CLI version. */
  async ping(agent, entry, binary) {
    const cwd = fs.mkdtempSync(path.join(this.tmpdir, 'clanker-warmup-'));
    const at = this.now().getTime(), base = { at, label: entry.label };
    try {
      for (const lean of agent === 'claude' ? [true, false] : [false]) { // only Claude has a lean variant
        const spec = commandFor(agent, entry, binary, { lean });
        const result = await this.execute(spec.command, spec.args, { cwd, input: spec.input, env: spec.env, timeoutMs: TIMEOUT_MS, maxBytes: 256 * 1024 }).catch((error) => ({ code: -1, output: '', stderr: error.message }));
        const read = readOutput(result.output);
        const completed = completedReply(result.output);
        if (result.code === 0 && completed.ok) {
          if (read.windows && agent === 'claude') this.record(agent, read.windows);
          return { ...base, status: 'done', tokens: read.tokens };
        }
        // Retrying without isolation only helps when this CLI rejected a command-line flag.
        const flagRefused = /(?:unknown|unrecognized|unexpected|unsupported|invalid) (?:option|argument|flag)|(?:option|argument|flag).*?(?:unknown|unrecognized|unexpected|unsupported|invalid)/i.test(`${result.stderr}\n${result.output}`);
        if (!lean || !flagRefused) return { ...base, status: 'failed', error: String(completed.error || result.stderr || (result.code === 0 ? 'No completed reply from CLI' : result.output || `exit ${result.code}`)).trim().slice(-200) };
      }
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  }
}

module.exports = { SessionWarmup, cheapestModel, commandFor, readOutput, PROMPT, WINDOW_MS, WEEK_MS };
