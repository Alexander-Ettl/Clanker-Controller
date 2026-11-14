'use strict';

// Calling a model from the loop, whichever CLI it lives behind. `analyze` is a read-only call that must return one JSON object
// matching a schema; `edit` changes files in a private copy. A pool runs many of them at once under a shared slot limit, backs
// off when the provider pushes back, and retries what is worth retrying (rate limits, a reply that was not valid JSON).

const { runFlash, validateReport } = require('./investigation-runner');
const { runFixer, runReader } = require('./investigation-fixer');
const { Semaphore, sleep } = require('./loop-exec');

const TRANSIENT = /\b(?:429|rate.?limit|resource.?exhausted|overloaded|unavailable|try again|temporar|ECONNRESET|ETIMEDOUT|socket hang up|50[023])\b/i;
const BAD_REPLY = /returned no JSON|incomplete JSON|Invalid report|missing or unsupported fields|did not return a completed|returned no report|Evidence must cite/i;
const FATAL = /Measured token allowance reached|forbidden tool|denied action|not installed|CLI unavailable|CLI missing/i;

const IDLE_MS = 6 * 60000, CAP_MS = 25 * 60000;

/**
 * One read-only call. `target` is `{agent, model}`. Gemini goes through Antigravity's custom-agent mode with no tools; Claude and
 * Codex run with tools off or a read-only sandbox, with the task carried in the prompt. Validates the reply against `schema`
 * and `supplied` (the lines the reader was given). Resolves `{report, tokens}`.
 */
async function analyze({ target, cwd, prompt, task, schema, supplied, signal, maxTokens, timeoutMs = CAP_MS, idleMs = IDLE_MS, logFile, onActivity, onStatus, onSpawn, tools, readRoot, maxViews }, deps = {}) {
  const flash = deps.flash || runFlash, reader = deps.reader || runReader;
  const call = async text => {
    onStatus?.('waiting');
    if (target.agent === 'gemini') return flash({ cwd, prompt: text, model: target.model, signal, maxTokens, timeoutMs, idleMs, onActivity, onStatus, logFile, task, schema, tools, readRoot, maxViews });
    return reader({ agent: target.agent, model: target.model, cwd, prompt: `${task}\n\n${text}`, signal, timeoutMs, idleMs, logFile, onActivity, onStatus, onSpawn });
  };
  let note = '', last;
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await call(note ? `${prompt}\n\nYour previous reply was rejected: ${note} Reply with exactly one valid JSON object that follows the schema.` : prompt);
    try { validateReport(result.report, supplied || new Map(), schema); return result; }
    catch (error) { last = error; note = error.message; error.tokenUsage = result.tokens; }
  }
  throw last;
}

/** One edit in `cwd`. `target` is `{agent, model}`. Resolves `{reply, tokens}`. */
function edit({ target, cwd, prompt, signal, timeoutMs, idleMs = IDLE_MS, logFile, onActivity, onSpawn }, deps = {}) {
  return (deps.fixer || runFixer)({ agent: target.agent, model: target.model, cwd, prompt, signal, timeoutMs, idleMs, logFile, onActivity, onSpawn });
}

/**
 * Runs jobs concurrently: at most `limit` at once here, and at most the shared `slots` across every loop. A rate-limit reply
 * halves this pool's limit for the rest of the run and retries the job after a pause. `fn(release)` receives nothing special; it
 * simply runs inside the slots.
 */
function createPool({ limit = 10, slots = null, signal, backoffMs = 20000, retries = 2, onRetry = () => {} } = {}) {
  const local = new Semaphore(limit);
  let throttled = false;
  async function run(fn) {
    let attempt = 0;
    for (;;) {
      const releaseLocal = await local.acquire(signal);
      let releaseShared = () => {};
      try {
        if (slots) releaseShared = await slots.acquire(signal);
        return await fn();
      } catch (error) {
        signal?.throwIfAborted();
        const retryable = !FATAL.test(error.message) && attempt < retries && (TRANSIENT.test(error.message) || BAD_REPLY.test(error.message) && attempt < 1);
        if (!retryable) throw error;
        attempt++;
        if (TRANSIENT.test(error.message) && !throttled && limit > 2) { throttled = true; local.resize(Math.max(2, Math.floor(limit / 2))); }
        onRetry(error, attempt);
        releaseShared(); releaseLocal();
        releaseShared = () => {};
        await sleep(backoffMs * attempt * (0.7 + Math.random() * 0.6), signal);
        continue;
      } finally { releaseShared(); releaseLocal(); }
    }
  }
  return { run, get throttled() { return throttled; } };
}

module.exports = { analyze, edit, createPool, TRANSIENT, BAD_REPLY, IDLE_MS, CAP_MS };
