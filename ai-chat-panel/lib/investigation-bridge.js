'use strict';

// The webview never reaches the investigation manager directly. It sends `{type:'investigations', requestId, request}`;
// this bridge checks the request shape, runs the backend action, and answers with the same requestId plus a fresh
// snapshot. Manager changes are pushed as `investigationsState` until the bridge is disposed with its view.

const LIMIT_KEYS = ['intervalMinutes', 'maxRuns', 'maxRunMinutes', 'maxTokensPerRun', 'reservePercent', 'hourlyTokens', 'fixesPerCycle', 'fixMinutes'];
const UNAVAILABLE = 'Loops are managed by another IDE window. Close that window or use it to manage them.';

const ROLE_KEYS = ['scout', 'editor', 'visualEditor', 'vision'];
const OPTION_KEYS = ['visual', 'agents', 'parallelFixes'];
const identifier = value => {
  if (typeof value !== 'string' || !/^[\w.-]{1,80}$/.test(value)) throw new Error('Invalid identifier.');
  return value;
};
function limitsOf(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid limits.');
  const limits = {};
  for (const [key, number] of Object.entries(value)) {
    if (!LIMIT_KEYS.includes(key)) throw new Error('Unknown investigation limit.');
    if (typeof number !== 'number') throw new Error(`Invalid ${key}.`);
    limits[key] = number;
  }
  return limits;
}

function rolesOf(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid model roles.');
  const roles = {};
  for (const [role, choice] of Object.entries(value)) {
    if (!ROLE_KEYS.includes(role)) throw new Error('Unknown model role.');
    roles[role] = identifier(choice);
  }
  return roles;
}
function optionsOf(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid loop options.');
  const options = {};
  for (const [key, choice] of Object.entries(value)) {
    if (!OPTION_KEYS.includes(key)) throw new Error('Unknown loop option.');
    if (typeof choice !== 'string' && !Number.isInteger(choice)) throw new Error('Invalid loop option.');
    options[key] = choice;
  }
  return options;
}

/** Whitelists the action and copies only the fields it needs; anything else in the message is dropped. */
function cleanRequest(request) {
  if (!request || typeof request !== 'object' || typeof request.action !== 'string') throw new Error('Invalid investigation request.');
  const { action } = request;
  switch (action) {
    case 'list': case 'stopAll': case 'options': return { action };
    case 'create': {
      const clean = { action, projectId: identifier(request.projectId) };
      if (request.model !== undefined) clean.model = identifier(request.model);
      if (request.recipe !== undefined) clean.recipe = identifier(request.recipe);
      if (request.mode !== undefined) clean.mode = identifier(request.mode);
      if (request.roles !== undefined) clean.roles = rolesOf(request.roles);
      if (request.options !== undefined) clean.options = optionsOf(request.options);
      if (request.limits !== undefined) clean.limits = limitsOf(request.limits);
      if (request.expiresAt !== undefined) {
        if (request.expiresAt !== null && !Number.isFinite(request.expiresAt)) throw new Error('Invalid expiry.');
        clean.expiresAt = request.expiresAt;
      }
      return clean;
    }
    case 'configure': return { action, id: identifier(request.id), limits: limitsOf(request.limits) || {}, ...(request.mode !== undefined ? { mode: identifier(request.mode) } : {}),
      ...(request.roles !== undefined ? { roles: rolesOf(request.roles) } : {}), ...(request.options !== undefined ? { options: optionsOf(request.options) } : {}) };
    case 'setRoles': return { action, roles: rolesOf(request.roles) || {} };
    case 'start': case 'pause': case 'runNow': case 'delete': return { action, id: identifier(request.id) };
    case 'report': case 'handoff': case 'apply': return { action, runId: identifier(request.runId) };
    case 'openArtifact': {
      if (typeof request.name !== 'string' || !/^[\w.-]{1,80}$/.test(request.name)) throw new Error('Invalid artifact name.');
      return { action, runId: identifier(request.runId), name: request.name };
    }
    case 'review': return { action, runId: identifier(request.runId), modelId: identifier(request.modelId) };
    default: throw new Error('Unknown investigation action.');
  }
}

const FLASH = /^gemini-[\d.]+-flash(?:-(?:low|medium|high))?$/;

/** What the Loops tab may offer: registered code projects, Flash models to diagnose with, and every other model for review. */
function investigationOptions({ projects = [], projectId = null, models = [], isEnabled = () => true }) {
  const usable = models.filter(model => isEnabled(model.agent));
  const flash = model => model.agent === 'gemini' && FLASH.test(model.model);
  const pick = ({ id, label, agent }) => ({ id, label, agent });
  return {
    projects: projects.filter(project => project.root).map(({ id, name, root }) => ({ id, name, root })),
    projectId,
    flashModels: usable.filter(flash).map(pick),
    reviewModels: usable.filter(model => !flash(model)).map(pick),
  };
}

/**
 * getInvestigations(): the installed `{manager, api}` or null (another window owns the storage).
 * getOptions(): `{projects, projectId, flashModels, reviewModels}` for the creation form and the Review picker.
 * review({projectId, prompt, modelId}): opens a new chat bound to the project with the prompt as an unsent draft.
 */
function createInvestigationBridge({ getInvestigations, getOptions = () => ({}), review, post }) {
  let unsubscribe = null;
  let disposed = false;

  function watch(investigations) {
    if (unsubscribe || disposed || !investigations.manager?.on) return;
    const listener = state => { if (!disposed) post({ type: 'investigationsState', available: true, state }); };
    investigations.manager.on('change', listener);
    unsubscribe = () => investigations.manager.off('change', listener);
  }

  async function handle(message) {
    if (disposed || !message || typeof message.requestId !== 'string' || message.requestId.length > 80) return;
    const { requestId } = message;
    let action = null;
    const reply = payload => { if (!disposed) post({ type: 'investigationsResult', requestId, action, ...payload }); };
    try {
      const request = cleanRequest(message.request);
      action = request.action;
      const investigations = getInvestigations();
      if (!investigations) return reply({ ok: false, unavailable: true, error: UNAVAILABLE });
      watch(investigations);
      let result;
      if (action === 'options') result = getOptions();
      else if (action === 'review') {
        const options = getOptions();
        if (!(options.reviewModels || []).some(model => model.id === request.modelId)) throw new Error('Choose one of the listed review models.');
        const { projectId, prompt } = await investigations.api({ action: 'handoff', runId: request.runId });
        result = await review({ projectId, prompt, modelId: request.modelId });
      } else result = await investigations.api(request);
      reply({ ok: true, result, state: investigations.manager.snapshot() });
    } catch (error) {
      let state;
      try { state = getInvestigations()?.manager.snapshot(); } catch { /* the error itself is what matters */ }
      reply({ ok: false, error: error.message, ...(state ? { state } : {}) });
    }
  }

  return {
    handle,
    get subscribed() { return Boolean(unsubscribe); },
    dispose() { disposed = true; unsubscribe?.(); unsubscribe = null; },
  };
}

module.exports = { createInvestigationBridge, investigationOptions, cleanRequest, UNAVAILABLE };
