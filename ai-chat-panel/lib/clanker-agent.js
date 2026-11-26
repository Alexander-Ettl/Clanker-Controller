'use strict';

// clanker-agent: lets an AI agent hand a task to Claude, Codex, Antigravity or Copilot and get
// the answer back as a file. Every agent already has a shell, so this is a shell command, not a tool of any one vendor.
//
//   start  --to "<model>" --task <name> --prompt-file <file>   begin in the background, return at once
//   wait   <task>... [--timeout 540]                            block until done (or the timeout), print where the result is
//   run    ...same as start...                                  start, then wait; the job keeps going if the wait times out
//   status | result | cancel | list | models
//
// One folder per task, `<cwd>/_work/clanker/<task>/`: request.json, prompt.md, status.json (queued / running / done / failed /
// cancelled, a heartbeat, the reason when it failed), result.md (the answer; on a failure it holds what was said so far, marked
// INCOMPLETE) and log.jsonl. The command that runs the model is the one the loop already uses (lib/investigation-fixer.js).
// Clanker's extension publishes its model picker and a launcher to ~/.clanker/ (publish()), so `--to` takes the names the picker shows.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const HEARTBEAT_MS = 5000;
const NEVER_STARTED_MS = 30000;
const WAIT_SECONDS = 540; // under the 10 minutes a shell tool usually allows
const TERMINAL = new Set(['done', 'failed', 'cancelled']);
const AGENTS = ['claude', 'codex', 'gemini', 'copilot'];
const VENDOR_TARGET = new RegExp(`^(${AGENTS.join('|')})(?::(.*))?$`, 'i');
const homeDir = () => process.env.CLANKER_HOME || path.join(os.homedir(), '.clanker');
const now = () => new Date().toISOString();
const readJson = (file, fallback = null) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const slug = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const seconds = (from, to = Date.now()) => Math.max(0, Math.round((to - Date.parse(from)) / 1000));
const clock = (total) => (total >= 60 ? `${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s` : `${total}s`);

// ---- models ---------------------------------------------------------------------------------------------------------------

const words = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9.]+/g, ' ').trim().split(' ').filter(Boolean);
const effortOf = (entry) => entry.effort || /-(low|medium|high|xhigh|max|ultra)$/.exec(entry.model || entry.id || '')?.[1] || null;

/**
 * "Gemini 4 Argon Medium", "Codex Sol 6.1 Medium", "gpt-6.1-sol-medium" or "codex:gpt-6.1-sol" -> one catalog entry. Every word of
 * the query must appear in the entry's label, id, vendor or company. A query that only leaves the effort open takes medium; a
 * query that fits a CLI's own model and the same model reached through another CLI takes the native one. Otherwise it is
 * ambiguous and the error lists the candidates. `agent:model` with no match is passed through, so a brand-new model still works.
 */
function resolveTarget(query, catalog) {
  const text = String(query || '').trim();
  if (!text) throw new Error('No model given. Use --to "<model>"; `models` lists the names.');
  const named = VENDOR_TARGET.exec(text);
  if (named && !named[2]) {
    const own = catalog.filter((entry) => entry.agent === named[1].toLowerCase());
    const pick = own.find((entry) => entry.isDefault) || own[0];
    if (!pick) throw new Error(`No ${named[1]} models are known. Name one: --to "${named[1].toLowerCase()}:<model>".`);
    return { agent: pick.agent, model: pick.model, effort: pick.effort || null, label: pick.label || pick.model };
  }
  const scope = named ? named[1].toLowerCase() : null;
  const pool = scope ? catalog.filter((entry) => entry.agent === scope) : catalog;
  const wanted = words(named ? named[2] : text);
  const known = (entry) => new Set([...words(entry.label), ...words(entry.id), ...words(entry.model), entry.agent, ...words(entry.company)]);
  const exact = pool.filter((entry) => [entry.id, entry.label, entry.model, `${entry.model} ${effortOf(entry) || ''}`].some((value) => words(value).join(' ') === wanted.join(' ')));
  let found = exact.length ? exact : pool.filter((entry) => { const have = known(entry); return wanted.every((word) => have.has(word)); });
  if (found.length > 1 && !wanted.some((word) => /^(low|medium|high|xhigh|max|ultra)$/.test(word))) {
    const medium = found.filter((entry) => effortOf(entry) === 'medium');
    if (medium.length) found = medium;
  }
  if (found.length > 1) { const native = found.filter((entry) => entry.agent !== 'copilot' && !String(entry.id).includes(':')); if (native.length) found = native; }
  if (found.length === 1) { const { agent, model, effort, label } = found[0]; return { agent, model, effort: effort || null, label: label || model }; }
  if (scope && (named[2] || '').trim()) return { agent: scope, model: named[2].trim(), effort: null, label: named[2].trim() };
  if (!found.length) throw new Error(`No model matches "${text}". Run \`models\` to list the names, or write agent:model (for example codex:gpt-6.1-sol).`);
  throw new Error(`"${text}" fits ${found.length} models: ${found.slice(0, 6).map((entry) => `${entry.agent}:${entry.id.replace(/^\w+:/, '')}`).join(', ')}. Say which, with the effort (low/medium/high) or an agent: prefix.`);
}

/** The picker as the extension last published it; without that, whatever the CLIs can list quickly (Codex's cache, `agy models`). */
function readCatalog(home = homeDir()) {
  const published = readJson(path.join(home, 'agent-bridge.json'));
  if (Array.isArray(published?.models) && published.models.length) return Object.assign(published.models, { published: true });
  const providers = require('./providers');
  const { locate } = require('./binary-locator');
  const found = [];
  try { found.push(...providers.get('codex').parseModels(fs.readFileSync(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'models_cache.json'), 'utf8'))); } catch { /* no cache */ }
  const agy = locate('gemini').path;
  if (agy) { const out = spawnSync(agy, ['models'], { encoding: 'utf8', timeout: 30000, windowsHide: true }); if (out.status === 0) found.push(...providers.get('gemini').parseModels(out.stdout)); }
  return found;
}

// ---- the extension's side -------------------------------------------------------------------------------------------------

/** Called by the extension whenever its model list changes: the catalog for `--to`, and a fixed-path launcher that survives folder moves. */
function publish({ models = [], faults = {}, home = homeDir(), script = __filename } = {}) {
  fs.mkdirSync(home, { recursive: true });
  const target = fs.realpathSync(script);
  const launcher = [
    '// Written by Clanker Controller; it rewrites this file at every start. Run with: node <this file> <command>',
    "'use strict';",
    `const target = ${JSON.stringify(target)};`,
    'let cli;',
    "try { cli = require(target); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; console.error(`Clanker Controller is not at ${target} any more. Open the IDE once so it rewrites this file.`); process.exit(3); }",
    'cli.main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => { console.error(error.message); process.exitCode = 1; });',
    '',
  ].join('\n');
  const catalog = models.filter(({ agent }) => AGENTS.includes(agent)).map(({ id, agent, model, effort, label, company, isDefault }) => ({ id, agent, model, effort: effort || null, label, company, ...(isDefault ? { isDefault: true } : {}) }));
  const write = (name, body) => { const file = path.join(home, name); try { if (fs.readFileSync(file, 'utf8') === body) return; } catch { /* new file */ } fs.writeFileSync(file, body); };
  write('clanker-agent.js', launcher);
  // `faults`: agent -> { title, detail } for a CLI the sidebar shows as unusable (signed out, plan ended). `start` refuses these at once.
  const known = Object.fromEntries(Object.entries(faults).filter(([, f]) => f).map(([agent, f]) => [agent, { title: String(f.title || '').slice(0, 200), detail: String(f.detail || '').slice(0, 300) }]));
  // The timestamp only moves when the content does or after 10 minutes, so an unchanged republish leaves the file alone.
  const bridgeFile = path.join(home, 'agent-bridge.json');
  const before = readJson(bridgeFile);
  const same = before && JSON.stringify([before.models, before.faults]) === JSON.stringify([catalog, known]) && Date.now() - Date.parse(before.publishedAt) < 10 * 60 * 1000;
  if (!same) writeJson(bridgeFile, { models: catalog, faults: known, publishedAt: now() });
  return path.join(home, 'clanker-agent.js');
}

// ---- jobs -----------------------------------------------------------------------------------------------------------------

const jobsRoot = (cwd) => path.join(cwd, '_work', 'clanker');

// A job lives under whatever --cwd it was started with, which is not always the chat's folder. So a job started from a chat
// (CLANKER_CHAT_ID) also leaves a pointer at <home>/jobs/<chat>/<id>.json; the chat's agents viewer follows these.
const chatKey = (chatId) => String(chatId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
function indexJob(chatId, dir, home = homeDir()) {
  if (!chatId) return;
  try {
    const folder = path.join(home, 'jobs', chatKey(chatId));
    fs.mkdirSync(folder, { recursive: true });
    const key = createHash('sha256').update(dir).digest('hex');
    writeJson(path.join(folder, `${key}.json`), { dir });
  } catch { /* the viewer is a convenience; the job itself already exists */ }
}
/** The job folders this chat started, wherever they are. */
function indexedJobs(chatId, home = homeDir()) {
  if (!chatId) return [];
  const folder = path.join(home, 'jobs', chatKey(chatId));
  let names;
  try { names = fs.readdirSync(folder); } catch { return []; }
  return names.filter((name) => name.endsWith('.json'))
    .map((name) => readJobMetadata(path.join(folder, name))?.dir)
    .filter((dir) => typeof dir === 'string' && path.isAbsolute(dir))
    .map((dir) => path.resolve(dir))
    .filter((dir) => path.basename(path.dirname(dir)) === 'clanker' && path.basename(path.dirname(path.dirname(dir))) === '_work');
}

function readJobMetadata(file) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isFile() && stat.size <= 64 * 1024) return readJson(file);
  } catch { /* missing or being replaced */ }
  return null;
}

function jobDir(task, cwd) {
  if (!task) throw new Error('Name the task (the --task you started it with) or give its folder.');
  const direct = path.resolve(cwd, task);
  if (fs.existsSync(path.join(direct, 'status.json'))) return direct;
  const named = path.join(jobsRoot(cwd), slug(task) || task);
  if (!fs.existsSync(path.join(named, 'status.json'))) throw new Error(`No task "${task}" under ${jobsRoot(cwd)}. \`list\` shows the tasks here; pass --cwd for another project.`);
  return named;
}

function patchStatus(dir, patch) {
  const file = path.join(dir, 'status.json');
  const next = { ...readJson(file, {}), ...patch, updatedAt: now() };
  writeJson(file, next);
  return next;
}

function wrapPrompt({ id, mode, text }) {
  return [
    `You were started by another AI agent through Clanker Controller (task "${id}"). Your final reply is saved to a file that agent reads later. It cannot answer questions, so do the whole task in one go and never ask for confirmation.`,
    '',
    'Rules for your reply:',
    '- Write in the language of the task.',
    '- Findings first, then a "Sources" list, then "Blocked or not found".',
    '- Give every source its URL and one tag: [READ] you opened the original page and read it, [SNIPPET] you only saw a search-result excerpt, [BLOCKED] you could not open it (add why: 403, login wall, captcha, paywall). Never tag a page [READ] that you did not open.',
    '- Keep quotes short and exact. Say what you could not verify.',
    mode === 'edit' ? '- You may edit files in the working folder. List every file you changed.' : '- Do not create, change or delete any file. Return everything in the reply itself.',
    '',
    'Task:',
    text.trim(),
  ].join('\n');
}

/** Creates the task folder and starts the worker. Resolves `{ id, dir, target }`; never throws after the folder exists (the failure goes into status.json). */
async function start(options, deps = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const catalog = deps.catalog || readCatalog(deps.home);
  const target = resolveTarget(options.to || (options.agent ? `${options.agent}:${options.model || ''}` : ''), catalog);
  if (!AGENTS.includes(target.agent)) throw new Error(`Unknown vendor "${target.agent}".`);
  const mode = options.mode === 'edit' ? 'edit' : 'read';
  const text = options.prompt || '';
  if (!text.trim()) throw new Error('No prompt. Use --prompt-file <file> (best), --prompt "<text>" or --prompt - for stdin.');
  const base = slug(options.task) || `${target.agent}-${new Date().toISOString().replace(/\D/g, '').slice(2, 14)}`;
  let id = base, n = 1;
  while (fs.existsSync(path.join(jobsRoot(cwd), id))) id = `${base}-${++n}`;
  const dir = path.join(jobsRoot(cwd), id);
  fs.mkdirSync(dir, { recursive: true });
  const request = { id, ...target, mode, cwd, from: options.from || process.env.CLANKER_CHAT_ID || null, task: text.slice(0, 2000), createdAt: now(), timeoutMin: Number(options.timeoutMin) || 45, idleMin: Number(options.idleMin) || 15 };
  writeJson(path.join(dir, 'request.json'), request);
  fs.writeFileSync(path.join(dir, 'prompt.md'), wrapPrompt({ id, mode, text }));
  writeJson(path.join(dir, 'status.json'), { id, state: 'queued', agent: target.agent, model: target.model, effort: target.effort, label: target.label, mode, createdAt: request.createdAt, updatedAt: request.createdAt });
  indexJob(request.from, dir, deps.home);
  if (deps.inline) return { id, dir, target, request };
  const fault = publishedFault(target.agent, deps.home);
  if (fault) {
    patchStatus(dir, { state: 'failed', error: fault, hint: hintFor(target.agent, 'sign in'), finishedAt: now() });
    fs.writeFileSync(path.join(dir, 'result.md'), `> INCOMPLETE: ${fault}\n\n(the task was not started)\n`);
    return { id, dir, target, request };
  }
  try {
    const { nodeCommand } = require('./loop-exec');
    const node = nodeCommand();
    const child = spawn(node.command, [__filename, '_worker', dir], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ...node.env } });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  } catch (error) {
    patchStatus(dir, { state: 'failed', error: `The background worker could not start: ${error.message}`, hint: 'Run it in the foreground instead: `run` waits in this shell.', finishedAt: now() });
  }
  return { id, dir, target, request };
}

const FAULT_FRESH_MS = 60 * 60 * 1000;
/** Why the sidebar says this CLI cannot be used right now, from what the extension last published (null: fine, unknown or too old to trust). */
function publishedFault(agent, home = homeDir()) {
  const published = readJson(path.join(home, 'agent-bridge.json'));
  const fault = published?.faults?.[agent];
  if (!fault || !(Date.now() - Date.parse(published.publishedAt) < FAULT_FRESH_MS)) return null;
  return `${fault.title}${fault.detail ? `: ${fault.detail}` : ''}`.slice(0, 300);
}

const HINTS = [
  [/not installed/i, (agent) => `Install the ${agent} CLI from Clanker Controller (Settings > General).`],
  [/\b401\b|unauthori|not logged in|log ?in|sign ?in|credential|auth/i, (agent) => `Not signed in? Sign in to ${agent} (the Clanker sidebar ring shows it), then start the task again.`],
  [/rate.?limit|\b429\b|quota|usage limit|limit reached|resource.?exhausted/i, () => 'Usage limit reached. Try again after it resets, or use another model.'],
  [/No activity for|time limit/i, () => 'It went quiet or ran past the time limit. result.md keeps what it had said by then.'],
];
const hintFor = (agent, message) => HINTS.find(([pattern]) => pattern.test(message))?.[1](agent) || null;

/** Runs one task to its end inside this process (the detached worker, or `--inline`). Always leaves status.json in a final state. */
async function runJob(dir, deps = {}) {
  const request = readJson(path.join(dir, 'request.json'));
  const fixer = deps.fixer || require('./investigation-fixer');
  const prompt = fs.readFileSync(path.join(dir, 'prompt.md'), 'utf8');
  const started = now();
  patchStatus(dir, { state: 'running', pid: process.pid, startedAt: started });
  const heartbeat = setInterval(() => { try { patchStatus(dir, {}); } catch { /* the folder is gone */ } }, HEARTBEAT_MS);
  let written = '', lastPartialWrite = 0;
  const saveProgress = (state) => {
    if (!state.partial || state.partial === written || Date.now() - lastPartialWrite < 2000) return;
    written = state.partial; lastPartialWrite = Date.now();
    fs.writeFileSync(path.join(dir, 'result.partial.md'), written);
    patchStatus(dir, { lastActivityAt: now(), partialChars: written.length });
  };
  const args = { agent: request.agent, model: request.model, effort: request.effort, cwd: request.cwd, prompt };
  try {
    const spec = deps.spec ? deps.spec(request, args) : (request.mode === 'edit' ? fixer.fixerSpec : fixer.researchSpec)(request.agent, args);
    const state = await fixer.runSpec(spec, request.agent, { cwd: request.cwd, timeoutMs: request.timeoutMin * 60000, idleMs: request.idleMin * 60000, logFile: path.join(dir, 'log.jsonl'), onActivity: () => {}, onProgress: saveProgress });
    const answer = (state.reply || state.partial || '').trim();
    if (!answer) throw Object.assign(new Error(`${request.agent} returned no answer.`), { state });
    fs.writeFileSync(path.join(dir, 'result.md'), `${answer}\n`);
    fs.rmSync(path.join(dir, 'result.partial.md'), { force: true });
    const warnings = request.mode === 'read' && /https?:\/\//.test(answer) && !/\[(READ|SNIPPET|BLOCKED)\]/.test(answer) ? ['The answer names URLs but has no [READ]/[SNIPPET]/[BLOCKED] tags. Treat its sources as unchecked.'] : [];
    patchStatus(dir, { state: 'done', finishedAt: now(), tokens: state.tokens, resultFile: 'result.md', warnings });
  } catch (error) {
    const partial = (error.state?.reply || error.state?.partial || '').trim();
    const reason = String(error.message || error).slice(0, 300);
    fs.writeFileSync(path.join(dir, 'result.md'), `> INCOMPLETE: ${reason}\n${partial ? `\n${partial}\n` : '\n(nothing was written before it stopped)\n'}`);
    patchStatus(dir, { state: 'failed', finishedAt: now(), error: reason, hint: hintFor(request.agent, `${reason} ${error.stderr || ''}`), ...(error.state?.providerResult ? { providerResult: error.state.providerResult } : {}), resultFile: 'result.md', partialChars: partial.length });
  } finally { clearInterval(heartbeat); }
}

/** status.json, corrected for a worker that is gone: a PC restart, a closed session or a sandbox that killed it must not look like "still running". */
function readStatus(dir, { readOnly = false } = {}) {
  const file = path.join(dir, 'status.json');
  let status = readOnly ? readJobMetadata(file) : readJson(file);
  if (!status) throw new Error(`${dir} has no status.json.`);
  if (!TERMINAL.has(status.state)) {
    const gone = status.pid ? !alive(status.pid) : seconds(status.createdAt) * 1000 > NEVER_STARTED_MS;
    if (gone) {
      const reason = status.pid ? 'The worker process ended without finishing (PC restart, closed session or a sandbox that kills background processes).' : 'The worker never started.';
      if (readOnly) return { ...status, state: 'failed', error: reason };
      const partial = (() => { try { return fs.readFileSync(path.join(dir, 'result.partial.md'), 'utf8').trim(); } catch { return ''; } })();
      if (!fs.existsSync(path.join(dir, 'result.md'))) fs.writeFileSync(path.join(dir, 'result.md'), `> INCOMPLETE: ${reason}\n${partial ? `\n${partial}\n` : '\n(nothing was written before it stopped)\n'}`);
      status = patchStatus(dir, { state: 'failed', error: reason, hint: 'Run it again with `run` (foreground), or start it from a normal terminal.', finishedAt: now(), resultFile: 'result.md', partialChars: partial.length });
    }
  }
  return status;
}

function describe(dir, status) {
  const age = seconds(status.startedAt || status.createdAt, status.finishedAt ? Date.parse(status.finishedAt) : Date.now());
  const who = `${status.agent}:${status.model}${status.effort ? ` (${status.effort})` : ''}`;
  const result = path.join(dir, status.resultFile || 'result.md');
  const lines = [`${status.state.toUpperCase().padEnd(9)} ${status.id}  ${who}  ${clock(age)}`];
  if (status.state === 'done') lines.push(`  result   ${result}`);
  else if (status.state === 'failed' || status.state === 'cancelled') {
    lines.push(`  why      ${status.error || status.state}`);
    if (status.hint) lines.push(`  hint     ${status.hint}`);
    if (fs.existsSync(result)) lines.push(`  partial  ${result}  (marked INCOMPLETE; ${status.partialChars || 0} chars of answer)`);
  } else {
    const quiet = status.updatedAt ? seconds(status.updatedAt) : 0;
    lines.push(`  folder   ${dir}`, `  progress ${status.partialChars ? `${status.partialChars} chars so far in result.partial.md` : 'no text yet'}${quiet > 60 ? `; no heartbeat for ${clock(quiet)}` : ''}`);
  }
  for (const warning of status.warnings || []) lines.push(`  warning  ${warning}`);
  return lines.join('\n');
}

async function wait(dirs, timeoutSeconds, out) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let statuses;
  for (;;) {
    statuses = dirs.map((dir) => readStatus(dir));
    if (statuses.every((status) => TERMINAL.has(status.state)) || Date.now() >= deadline) break;
    await sleep(2000);
  }
  dirs.forEach((dir, i) => out(describe(dir, statuses[i])));
  if (statuses.some((status) => !TERMINAL.has(status.state))) { out(`Still running after ${clock(timeoutSeconds)}. It keeps going in the background: call \`wait\` again, or read result.partial.md for what exists.`); return 2; }
  return statuses.every((status) => status.state === 'done') ? 0 : 1;
}

function cancel(dir) {
  const status = readStatus(dir);
  if (TERMINAL.has(status.state)) return status;
  if (status.pid) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(status.pid), '/T', '/F'], { windowsHide: true });
    else { try { process.kill(-status.pid, 'SIGTERM'); } catch { try { process.kill(status.pid, 'SIGTERM'); } catch { /* already gone */ } } }
  }
  const partial = (() => { try { return fs.readFileSync(path.join(dir, 'result.partial.md'), 'utf8').trim(); } catch { return ''; } })();
  fs.writeFileSync(path.join(dir, 'result.md'), `> INCOMPLETE: cancelled by the caller\n${partial ? `\n${partial}\n` : ''}`);
  return patchStatus(dir, { state: 'cancelled', error: 'Cancelled by the caller.', finishedAt: now(), resultFile: 'result.md', partialChars: partial.length });
}

// ---- command line ---------------------------------------------------------------------------------------------------------

const VALUE_FLAGS = new Set(['to', 'agent', 'model', 'task', 'mode', 'cwd', 'prompt', 'prompt-file', 'timeout', 'timeout-min', 'idle-min', 'from']);

function parseArgs(argv) {
  const flags = {}, rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!match) { rest.push(arg); continue; }
    if (!VALUE_FLAGS.has(match[1])) { flags[match[1]] = true; continue; }
    flags[match[1]] = match[2] ?? argv[++i];
  }
  return { flags, rest };
}

const USAGE = `clanker-agent: hand a task to a model from another vendor and get the answer back as a file.
  start  --to "<model>" [--task <name>] (--prompt-file <file> | --prompt "<text>" | --prompt -) [--cwd <project>] [--mode read|edit]
  run    (same options)       start, then wait up to ${WAIT_SECONDS}s; the task keeps going in the background if it takes longer
  wait   <task>... [--timeout <seconds>]
  status <task>...   result <task>   cancel <task>   list   models [filter]
Tasks live in <cwd>/_work/clanker/<task>/ (status.json, result.md).`;

async function main(argv, io = {}) {
  const out = io.out || ((text) => process.stdout.write(`${text}\n`));
  const { flags, rest } = parseArgs(argv);
  const [command, ...names] = rest;
  const cwd = path.resolve(flags.cwd || process.cwd());
  try {
    // CLANKER_AGENT_SPEC_MODULE: a module exporting (request, args) => spec, so tests can run the detached worker against a fake CLI.
    if (command === '_worker') {
      const { readSettings } = require('./headless-runner.js');
      require('./cli-telemetry.js').configureCliTelemetry(() => readSettings()?.cliTelemetry);
      await runJob(names[0], process.env.CLANKER_AGENT_SPEC_MODULE ? { spec: require(process.env.CLANKER_AGENT_SPEC_MODULE) } : {});
      return 0;
    }
    if (command === 'models') {
      const filter = words(names.join(' '));
      const all = readCatalog(io.home);
      const catalog = all.filter((entry) => { const text = new Set([...words(entry.label), ...words(entry.id), entry.agent, ...words(entry.company)]); return filter.every((word) => text.has(word)); });
      if (!catalog.length) { out('No models found. Open Clanker Controller once, or sign in to a CLI.'); return 1; }
      for (const entry of catalog) out(`${entry.agent.padEnd(7)} ${String(entry.label || entry.model).padEnd(34)} ${entry.id}`);
      out('Use any of these as --to "<label>", or agent:model for one that is not listed.');
      if (!all.published) out('Clanker Controller has not published its model list yet (open the IDE once), so Claude models are missing here. claude:opus, claude:sonnet and claude:haiku still work.');
      return 0;
    }
    if (command === 'start' || command === 'run') {
      let prompt = flags.prompt;
      if (flags['prompt-file']) prompt = fs.readFileSync(path.resolve(cwd, flags['prompt-file']), 'utf8');
      else if (prompt === '-') prompt = fs.readFileSync(0, 'utf8');
      const job = await start({ ...flags, prompt, cwd, timeoutMin: flags['timeout-min'], idleMin: flags['idle-min'] }, io);
      out(`started   ${job.id}  ${job.target.agent}:${job.target.model}${job.target.effort ? ` (${job.target.effort})` : ''}`);
      out(`  folder   ${job.dir}`);
      out(`  result   ${path.join(job.dir, 'result.md')}  (result.partial.md while it works; status.json says running/done/failed)`);
      if (io.inline) { await runJob(job.dir, io); return await wait([job.dir], 1, out); }
      if (command === 'start') { out(`  next     wait ${job.id}${cwd === process.cwd() ? '' : ` --cwd "${cwd}"`}   (then read the result file)`); return 0; }
      return await wait([job.dir], Number(flags.timeout) || WAIT_SECONDS, out);
    }
    if (command === 'list') {
      const root = jobsRoot(cwd);
      const dirs = fs.existsSync(root) ? fs.readdirSync(root).map((name) => path.join(root, name)).filter((dir) => fs.existsSync(path.join(dir, 'status.json'))) : [];
      if (!dirs.length) { out(`No tasks under ${root}.`); return 0; }
      for (const dir of dirs) out(describe(dir, readStatus(dir)));
      return 0;
    }
    if (['wait', 'status', 'result', 'cancel'].includes(command)) {
      const dirs = names.map((name) => jobDir(name, cwd));
      if (!dirs.length) throw new Error(`${command} needs a task name.`);
      if (command === 'wait') return await wait(dirs, Number(flags.timeout) || WAIT_SECONDS, out);
      if (command === 'status') { dirs.forEach((dir) => out(describe(dir, readStatus(dir)))); return 0; }
      if (command === 'cancel') { dirs.forEach((dir) => out(describe(dir, cancel(dir)))); return 0; }
      for (const dir of dirs) {
        const status = readStatus(dir);
        const file = path.join(dir, TERMINAL.has(status.state) ? 'result.md' : 'result.partial.md');
        out(fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trimEnd() : `No result yet (${status.state}).`);
      }
      return 0;
    }
    out(USAGE);
    return command ? 1 : 0;
  } catch (error) {
    (io.err || ((text) => process.stderr.write(`${text}\n`)))(`clanker-agent: ${error.message}`);
    return 1;
  }
}

module.exports = { AGENTS, publishedFault, indexedJobs, readJobMetadata, main, start, runJob, readStatus, cancel, resolveTarget, readCatalog, publish, wrapPrompt, parseArgs, jobDir, describe };

if (require.main === module) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
