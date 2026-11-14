'use strict';

// Version checks, updates and model discovery for the agent CLIs. Everything here
// asks the CLI itself (`--version`, `update`, `debug models`, `models`) so it
// follows whatever the user installed; only "what is the newest release" needs
// the npm registry. Claude reports its models through the SDK initialization
// handshake, without sending a prompt or generating a response.

const { execFile } = require('node:child_process');
const https = require('node:https');
const { locate, resolveShim, headlessEnv } = require('./binary-locator.js');
const { MODEL_CATALOG, normalizeModels, setModelCatalog, setFavoriteModels, setEnabledAgents, modelOption } = require('./model-catalog.js');
const { withPrompt, cleanPrompt, promptFor } = require('../media/model-prompts.js');

const providers = require('./providers'); // what to run per provider: lib/providers/<id>.js
const { parseVersion } = require('./providers/shared.js');
const DEFAULT_UPDATE_MS = 20000; // no CLI reports how far along `update` is; the bar paces itself on the last run
const AUTO_RETRY_MS = 6 * 60 * 60 * 1000;

// A routing decision can choose any provider. Protect all of them while planning;
// once dispatched, only the provider doing the work needs to stay untouched.
function providerBusy(agent, { runs = [], hosts = [], now = Date.now() } = {}) {
  for (const run of runs) {
    if (run.starting || run.planning) return true;
    if ((run.remote || run.streamEngine?.hasBackgroundAgents) && agent === 'claude') return true;
    const active = run.turnAgent || run.activeAssistantMessage?.agent;
    if (run.turn && (!active || active === agent)) return true;
    if (run.queue?.some(turn => turn.agentId === agent || modelOption(turn.modelId)?.agent === agent
      || turn.modelId === 'auto' || turn.agentId === 'auto' || (!turn.agentId && !modelOption(turn.modelId)))) return true;
  }
  return [...hosts].some(host => host.typingAt && now - host.typingAt < 30000
    && (host.activeAgent === agent || host.activeAgent === 'auto'));
}

// Extension hosts can replace global fetch with their own network stack.
// Public release feeds also work through Node's native HTTPS transport.
async function fetchRelease(url) {
  try { return await globalThis.fetch(url, { signal: AbortSignal.timeout(8000) }); }
  catch {
    return new Promise((resolve, reject) => {
      const request = https.get(url, (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { text += chunk; });
        response.on('error', reject);
        response.on('end', () => resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode,
          text: async () => text, json: async () => JSON.parse(text) }));
      });
      const timer = setTimeout(() => request.destroy(new Error('Release check timed out')), 8000);
      request.on('close', () => clearTimeout(timer));
      request.on('error', reject);
    });
  }
}

function isNewer(latest, current) {
  const a = String(latest || '').split('.').map(Number);
  const b = String(current || '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return false;
}

// Each provider parses its own CLI's model list (lib/providers/<id>.js); these hand back the normalized catalog entries.
const parseCodexModels = (text) => normalizeModels(providers.get('codex').parseModels(text));
const parseClaudeModels = (text) => normalizeModels(providers.get('claude').parseModels(text));
const parseAgyModels = (text) => normalizeModels(providers.get('gemini').parseModels(text));
const parseAgyLatest = (text) => providers.get('gemini').parseLatest(text);

/**
 * Runs a CLI (npm .cmd shims included) headless; never rejects. stdin is closed at once: `codex update` and
 * `agy update` wait on an open stdin pipe and would sit there until the timeout. `onLine` hears each output line.
 */
function runCli(file, args, timeout, onLine, input = '') {
  const isCmd = /\.cmd$/i.test(file);
  const shim = isCmd ? resolveShim(file) : null;
  const shell = isCmd && !shim;
  return new Promise((resolve) => {
    const child = execFile(shim ? shim.command : shell ? `"${file}"` : file, [...(shim ? shim.args : []), ...args], { windowsHide: true, timeout, shell, maxBuffer: 16 << 20, env: { ...process.env, ...headlessEnv(file) } },
      (error, stdout, stderr) => resolve({ ok: !error, code: error ? (Number.isInteger(error.code) ? error.code : null) : 0, stdout: String(stdout), stderr: String(stderr || error?.message || '') }));
    child.stdin?.on('error', () => {}); // a CLI may exit before it reads initialization
    child.stdin?.end(input);
    if (onLine) for (const stream of [child.stdout, child.stderr]) stream?.on('data', (chunk) => String(chunk).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).forEach(onLine));
  });
}

/**
 * The installed version, from `<cli> --version`. A slow first start (a cold disk, a virus scan) used to time the 8s
 * attempt out and leave the version blank until the next check hours later, so it gets a longer second try; and a
 * version printed to stderr, or with a non-zero exit, still counts.
 */
async function installedVersion(agent) {
  const file = locate(agent).path;
  if (!file) return null;
  const args = providers.get(agent)?.versionArgs || ['--version'];
  for (const timeout of [10000, 25000]) {
    const { stdout, stderr } = await runCli(file, args, timeout);
    const version = parseVersion(stdout) || parseVersion(stderr);
    if (version) return version;
  }
  return null;
}

/** The newest release: the provider's own `latestVersion(fetch)` when it has one (agy is not on npm), else the npm registry. */
async function latestVersion(agent, fetchImpl = fetchRelease) {
  const provider = providers.get(agent);
  let latest;
  const checkedFetch = async (...args) => {
    const res = await fetchImpl(...args);
    if (!res.ok) throw new Error(`Release service returned HTTP ${res.status}`);
    return res;
  };
  if (provider?.latestVersion) latest = await provider.latestVersion(checkedFetch);
  else if (provider?.npmPackage) latest = parseVersion((await (await checkedFetch(`https://registry.npmjs.org/${provider.npmPackage}/latest`, { signal: AbortSignal.timeout(8000) })).json()).version);
  if (!latest) throw new Error('Release service did not report an available version');
  return latest;
}

async function releaseStatus(agent, fetchImpl) {
  try { return { latest: await latestVersion(agent, fetchImpl), error: null }; }
  catch (error) { return { latest: null, error: error.cause?.message || error.message }; }
}

/** @returns {Promise<Record<string, { version: string | null, latest: string | null, outdated: boolean }>>} */
async function checkVersions() {
  const entries = await Promise.all(providers.ids().map(async (agent) => {
    const [version, release] = await Promise.all([installedVersion(agent), releaseStatus(agent)]);
    return [agent, { version, ...release, outdated: Boolean(version && release.latest && isNewer(release.latest, version)) }];
  }));
  return Object.fromEntries(entries);
}

/** Every CLI updates itself, by default with `<cli> update`. @returns {{ ok: boolean, message: string }} */
async function updateCli(agent, onLine) {
  const file = locate(agent).path;
  if (!file) return { ok: false, message: 'CLI not found' };
  const { ok, stdout, stderr } = await runCli(file, providers.get(agent)?.updateArgs || ['update'], 180000, onLine);
  // npm's cleanup warnings are noise; the last line that is not one carries the outcome.
  const lines = (ok ? stdout : stderr || stdout).split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !/^npm warn/i.test(line));
  return { ok, message: lines.at(-1) || (ok ? 'Updated' : 'Update failed') };
}

/** Each enabled provider's models, from its own discovery; null for an unavailable one: a failed refresh keeps its last good cache. */
async function fetchModels(enabled = providers.ids()) {
  const entries = await Promise.all(providers.all().map(async (provider) => {
    const file = enabled.includes(provider.id) ? locate(provider.id).path : null;
    if (!file) return [provider.id, null];
    try {
      const found = await provider.discoverModels({ file, runCli });
      return [provider.id, found ? normalizeModels(found) : null];
    } catch { return [provider.id, null]; }
  }));
  return Object.fromEntries(entries);
}

/**
 * The shared state behind the update icon and Settings > Models: installed/latest versions, the models the CLIs
 * report, and the starred ones. `broadcast` posts to every open chat window; favourites persist through the store.
 */
class CliHub {
  constructor({ store, promptStore, settingsStore, cacheStore, broadcast, discover = fetchModels, accounts = null, checkVersionsImpl = checkVersions,
    autoUpdateEnabled = () => false, isBusy = () => true, beforeUpdate = async () => {}, updateCliImpl = updateCli, installedVersionImpl = installedVersion, releaseStatusImpl = releaseStatus, now = Date.now }) {
    Object.assign(this, { autoUpdateEnabled, isBusy, beforeUpdate, updateCli: updateCliImpl, installedVersion: installedVersionImpl, releaseStatus: releaseStatusImpl, now });
    this.autoAttempts = {};
    this.updatePromises = new Map();
    this.accounts = accounts;
    this.store = store; // { get(): entry[], set(entry[]) }
    this.promptStore = promptStore; // { get(): { [modelId]: { text, label } }, set(map) }: the per-model prompts (model-prompts.js)
    this.prompts = promptStore.get();
    this.settingsStore = settingsStore;
    this.modelSettings = settingsStore?.get() || {};
    this.broadcast = broadcast;
    this.versions = {};
    this.checkVersions = checkVersionsImpl;
    this.checking = false;
    this.versionCheck = null;
    this.installedCheck = null;
    this.cacheStore = cacheStore;
    this.discover = discover;
    this.fetched = normalizeModels(cacheStore?.get() || []);
    this.updating = {}; // agent -> { startedAt, estimateMs, line }: updates run side by side, each with its own entry
    this.durations = {}; // agent -> how long its last update took, the next progress bar's pace
    this.notes = {}; // the last update's outcome per agent
    this.modelsBusy = false;
    const savedFavorites = this.store.get();
    const migratedFavorites = normalizeModels(savedFavorites);
    for (const entry of savedFavorites) {
      const migrated = migratedFavorites.find((model) => model.agent === entry.agent && model.model === entry.model && model.effort === entry.effort);
      if (!migrated || migrated.id === entry.id) continue;
      if (this.prompts[entry.id] && !this.prompts[migrated.id]) this.prompts = { ...this.prompts, [migrated.id]: this.prompts[entry.id] };
      if (this.modelSettings[entry.id] && !this.modelSettings[migrated.id]) this.modelSettings = { ...this.modelSettings, [migrated.id]: this.modelSettings[entry.id] };
    }
    if (savedFavorites.some((entry, i) => entry.id !== migratedFavorites[i]?.id)) {
      this.store.set(migratedFavorites);
      this.promptStore.set(this.prompts);
      this.settingsStore?.set(this.modelSettings);
    }
    setEnabledAgents(this.accounts?.enabledAgents() || providers.ids());
    setModelCatalog(this.fetched);
    setFavoriteModels(this.store.get());
  }

  snapshot() {
    const favorites = this.store.get().map((entry) => entry.id);
    return { type: 'cliStatus', versions: this.versions, checking: this.checking, updating: this.updating, notes: this.notes, catalog: [...MODEL_CATALOG], prompts: this.prompts, modelSettings: this.modelSettings, fetched: this.available(), favorites, modelsBusy: this.modelsBusy, updates: providers.ids().filter((agent) => this.versions[agent]?.outdated) };
  }

  push() {
    this.broadcast({ type: 'modelPrompts', models: this.available().filter((option) => promptFor(this.prompts, option)).map((option) => option.id) });
    this.broadcast(this.snapshot());
  }

  available() { return this.fetched.filter((entry) => this.accounts?.isEnabled(entry.agent) !== false); }

  connectionsChanged() {
    setEnabledAgents(this.accounts?.enabledAgents() || providers.ids());
    this.broadcast({ type: 'modelCatalog', catalog: [...MODEL_CATALOG], available: this.available() });
    this.push();
  }

  check() {
    if (this.versionCheck) return this.versionCheck;
    const previous = this.versions;
    this.checking = true;
    this.push();
    this.versionCheck = this.checkVersions().then((versions) => {
      for (const [agent, info] of Object.entries(versions)) {
        // An update or a local version refresh may have completed while the
        // release service was responding. Never put its older version back.
        if (!this.updating[agent] && this.versions[agent] === previous[agent]) this.setVersion(agent, info);
      }
    }).finally(() => {
      this.checking = false;
      this.versionCheck = null;
      this.push();
    });
    return this.versionCheck;
  }

  setVersion(agent, info) {
    this.versions = { ...this.versions, [agent]: info };
    if (info.version && info.latest && !isNewer(info.latest, info.version) && this.notes[agent]?.ok === false) {
      const { [agent]: _staleNote, ...notes } = this.notes;
      this.notes = notes;
    }
  }

  // A CLI's own updater (or another IDE window) can finish after `update`
  // reports "already in progress". Re-read local versions without polling
  // release services or starting another update, even with auto-update off.
  refreshInstalled() {
    if (this.installedCheck) return this.installedCheck;
    const previous = this.versions;
    this.installedCheck = Promise.allSettled(Object.entries(previous)
      .filter(([agent, info]) => !this.updating[agent] && (info.outdated || this.notes[agent]?.ok === false))
      .map(async ([agent, info]) => {
        const version = await this.installedVersion(agent);
        if (!version || this.updating[agent] || this.versions[agent] !== info) return;
        this.setVersion(agent, { ...info, version, outdated: Boolean(info.latest && isNewer(info.latest, version)) });
      })).finally(() => {
      this.installedCheck = null;
      this.push();
    });
    return this.installedCheck;
  }

  async updateAll() {
    if (!Object.keys(this.versions).length) await this.check();
    return Promise.allSettled(providers.ids()
      .filter((agent) => this.versions[agent]?.outdated && this.accounts?.isEnabled(agent) !== false)
      .map((agent) => this.update(agent)));
  }

  async autoUpdate() {
    if (!this.autoUpdateEnabled() || this.checking) return;
    return Promise.allSettled(providers.ids().filter(agent => this.versions[agent]?.outdated
      && this.accounts?.isEnabled(agent) !== false && !this.updating[agent]
      && !this.isBusy(agent) && this.now() >= (this.autoAttempts[agent] || 0))
      .map(agent => {
        this.autoAttempts[agent] = this.now() + AUTO_RETRY_MS;
        return this.update(agent, { background: true });
      }));
  }

  update(agent, options) {
    if (this.updatePromises.has(agent)) return this.updatePromises.get(agent);
    const promise = this.performUpdate(agent, options).finally(() => this.updatePromises.delete(agent));
    this.updatePromises.set(agent, promise);
    return promise;
  }

  async performUpdate(agent, { background = false } = {}) {
    if (!providers.has(agent) || this.updating[agent]) return;
    const startedAt = Date.now();
    const track = (line) => { if (this.updating[agent]) { this.updating = { ...this.updating, [agent]: { ...this.updating[agent], line } }; this.push(); } };
    this.updating = { ...this.updating, [agent]: { startedAt, estimateMs: this.durations[agent] || DEFAULT_UPDATE_MS, line: '', background } };
    this.notes = { ...this.notes, [agent]: '' };
    this.push();
    let result, version, release;
    try {
      await this.beforeUpdate(agent);
      result = await this.updateCli(agent, background ? undefined : track);
      [version, release] = await Promise.all([this.installedVersion(agent), this.releaseStatus(agent)]);
    } catch (error) {
      result = { ok: false, message: error.message };
      version = this.versions[agent]?.version;
      release = { latest: this.versions[agent]?.latest, error: error.message };
    }
    this.durations[agent] = Date.now() - startedAt;
    const { [agent]: _done, ...rest } = this.updating;
    this.updating = rest;
    this.notes = { ...this.notes, [agent]: { ok: result.ok, text: result.message, completedAt: Date.now() } };
    // Keep the last known release if a post-update network lookup fails.
    const latest = release.latest || this.versions[agent]?.latest;
    this.setVersion(agent, { version, ...release, latest, outdated: Boolean(version && latest && isNewer(latest, version)) });
    this.push();
  }

  async refreshModels() {
    if (this.modelsBusy) return;
    this.modelsBusy = true;
    this.push();
    try {
      const discovered = await this.discover(this.accounts?.enabledAgents() || providers.ids());
      const previous = this.fetched;
      this.fetched = normalizeModels(providers.ids().flatMap((agent) => discovered[agent] ?? previous.filter((entry) => entry.agent === agent)));
      this.cacheStore?.set(this.fetched);
      // First discovery for a provider starts with its reported default. Every
      // heart remains editable; existing favorites retain their exact effort.
      const favorites = this.store.get();
      const defaults = this.fetched.filter((entry) => entry.isDefault && !previous.some((old) => old.agent === entry.agent)
        && !favorites.some((favorite) => favorite.agent === entry.agent));
      const next = [...favorites, ...defaults];
      if (defaults.length) this.store.set(next);
      setModelCatalog(this.fetched);
      setFavoriteModels(next);
      this.broadcast({ type: 'modelCatalog', catalog: MODEL_CATALOG, available: this.available() });
    } finally { this.modelsBusy = false; }
    this.push();
  }

  /** Settings > Models: set (or, with empty text, clear) the prompt of one model; every window's picker re-marks its rows. */
  setPrompt(model, label, text) {
    this.prompts = withPrompt(this.prompts, model, label, text);
    // An empty exact-model prompt overrides an older shared family prompt.
    if (!cleanPrompt(text) && this.fetched.some((entry) => entry.id === model)) this.prompts[model] = { text: '', label };
    this.promptStore.set(this.prompts);
    this.push();
  }

  setModelSettings(id, permissionMode) {
    if (!this.store.get().some((entry) => entry.id === id) || !['inherit', 'ask', 'auto', 'fullAccess'].includes(permissionMode)) return;
    this.modelSettings = { ...this.modelSettings };
    if (permissionMode === 'inherit') delete this.modelSettings[id];
    else this.modelSettings[id] = { permissionMode };
    this.settingsStore?.set(this.modelSettings);
    this.push();
  }

  changeFavorite(id, nextId) {
    const current = this.fetched.find((entry) => entry.id === id);
    const replacement = this.available().find((entry) => entry.id === nextId);
    const base = (entry) => entry.model.replace(/-(low|medium|high|xhigh|max|ultra)$/, '');
    if (!current || !replacement || current.agent !== replacement.agent || base(current) !== base(replacement)) return;
    const favorites = this.store.get();
    if (!favorites.some((entry) => entry.id === id)) return;
    if (this.modelSettings[id] && !this.modelSettings[nextId]) {
      this.modelSettings = { ...this.modelSettings, [nextId]: this.modelSettings[id] };
      this.settingsStore?.set(this.modelSettings);
    }
    if (!Object.prototype.hasOwnProperty.call(this.prompts, nextId)
      && (Object.prototype.hasOwnProperty.call(this.prompts, id) || promptFor(this.prompts, current))) {
      this.prompts = { ...this.prompts, [nextId]: { text: promptFor(this.prompts, current), label: replacement.label } };
      this.promptStore.set(this.prompts);
    }
    const next = favorites.filter((entry) => entry.id !== id && entry.id !== nextId);
    this.store.set([...next, replacement]);
    setFavoriteModels([...next, replacement]);
    this.broadcast({ type: 'modelCatalog', catalog: MODEL_CATALOG, available: this.available() });
    this.push();
  }

  toggleFavorite(id) {
    const favorites = this.store.get();
    const next = favorites.some((entry) => entry.id === id) ? favorites.filter((entry) => entry.id !== id) : [...favorites, this.fetched.find((entry) => entry.id === id)].filter(Boolean);
    this.store.set(next);
    setFavoriteModels(next);
    this.broadcast({ type: 'modelCatalog', catalog: MODEL_CATALOG, available: this.available() });
    this.push();
  }
}

module.exports = { parseVersion, parseAgyLatest, isNewer, parseCodexModels, parseClaudeModels, parseAgyModels, checkVersions, releaseStatus, updateCli, fetchModels, installedVersion, runCli, CliHub, providerBusy };
