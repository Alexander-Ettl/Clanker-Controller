'use strict';

// Who does what in a loop. Four roles, each a model choice the user can pin or leave on Automatic:
//   scout         reads and judges text: the ten finders, the verifiers and the fix judges (no edits)
//   editor        makes backend fixes in the loop's private copy
//   visualEditor  makes layout and styling fixes
//   vision        looks at screenshots (needs the Antigravity CLI, the only one that can open an image file headlessly)
// Automatic follows what is installed and enabled. Gemini is the default scout and vision model but is never chosen as an
// editor while Codex or Claude Code is available; it edits when the user picks it, or when nothing else can.

const ROLES = ['scout', 'editor', 'visualEditor', 'vision'];
const ROLE_NAMES = { scout: 'Scouts and verifiers', editor: 'Editor (backend fixes)', visualEditor: 'Editor (visual fixes)', vision: 'Screenshot review' };
const ROLE_HINTS = {
  scout: 'Reads the project, finds problems and checks each one. Never edits files.',
  editor: 'Makes the fixes for logic, data and tooling problems in the loop’s private copy.',
  visualEditor: 'Makes the fixes for layout and styling problems.',
  vision: 'Looks at screenshots of your pages. Needs the Antigravity CLI.',
};
const FLASH = /^gemini-([\d.]+)-flash(?:-(low|medium|high))?$/;
const AGENT_NAMES = { gemini: 'Gemini', claude: 'Claude', codex: 'Codex' };

const versionOf = model => Number((FLASH.exec(model)?.[1] || '0').split('.').reduce((sum, part, index) => sum + Number(part) / 100 ** index, 0));
const effortOf = model => ({ high: 3, medium: 2, low: 1 })[FLASH.exec(model)?.[2]] || 0;

/** Best Gemini Flash in the catalog: newest version, then highest effort. */
function bestFlash(models) {
  return models.filter(entry => entry.agent === 'gemini' && FLASH.test(entry.model))
    .sort((a, b) => versionOf(b.model) - versionOf(a.model) || effortOf(b.model) - effortOf(a.model))[0] || null;
}
/** A mid-sized model of an agent for reading work: not the largest one, which a scan of ten calls would burn through. */
function readerOf(agent, models, defaultModel) {
  const own = models.filter(entry => entry.agent === agent);
  return own.find(entry => /sonnet|mini|haiku|flash/i.test(entry.model)) || defaultModel(agent) || own[0] || null;
}
const entryTarget = entry => entry && { agent: entry.agent, model: entry.model, id: entry.id, label: entry.label || entry.model };

/**
 * ctx: { models: catalog entries, isEnabled(agent), installed(agent), defaultModel(agent), legacy?: {visualAgent, backendAgent} }
 * Returns the candidate targets for a role in order of preference (Automatic), or a single pinned target.
 */
function candidates(role, ctx) {
  const usable = agent => ctx.isEnabled(agent) && ctx.installed(agent);
  const model = agent => usable(agent) ? entryTarget(ctx.defaultModel(agent)) : null;
  const legacy = ctx.legacy || {};
  const list = [];
  if (role === 'scout') {
    if (usable('gemini')) list.push(entryTarget(bestFlash(ctx.models)));
    for (const agent of ['claude', 'codex']) if (usable(agent)) list.push(entryTarget(readerOf(agent, ctx.models, ctx.defaultModel)));
    if (usable('gemini')) list.push(entryTarget(ctx.defaultModel('gemini')));
  } else if (role === 'vision') {
    if (usable('gemini')) list.push(entryTarget(bestFlash(ctx.models)) || entryTarget(ctx.defaultModel('gemini')));
  } else {
    const first = role === 'visualEditor' ? legacy.visualAgent || 'claude' : legacy.backendAgent || 'codex';
    const order = [first, ...['codex', 'claude'].filter(agent => agent !== first)];
    for (const agent of order) { const target = model(agent); if (target) list.push(target); }
    // Gemini only edits when it is all there is; picking it on purpose is the explicit path in resolveRole.
    if (!list.length && usable('gemini')) list.push(entryTarget(ctx.defaultModel('gemini')));
  }
  return list.filter(Boolean);
}

/** A pinned value is a model id, or an agent id meaning that agent's default model. */
function pinned(value, ctx) {
  const entry = ctx.models.find(model => model.id === value || model.model === value);
  if (entry) return entryTarget(entry);
  if (AGENT_NAMES[value]) return entryTarget(value === 'gemini' && bestFlash(ctx.models) || ctx.defaultModel(value));
  return null;
}

/**
 * Picks the model for a role. `quotas` (agent -> reading) and `reservePercent` skip an agent that is short on quota, unless it is
 * the only choice the user made. Returns `{target, explicit, skipped}`; `target` is null when nothing can do the job.
 */
function resolveRole(role, ctx, { value = 'auto', quotas = null, reservePercent = 0 } = {}) {
  const usable = agent => ctx.isEnabled(agent) && ctx.installed(agent);
  const enough = agent => !quotas || !reservePercent || agent === 'gemini' || (() => {
    const reading = quotas[agent];
    return Boolean(reading) && [reading, reading.secondary].filter(Boolean).every(window => Number.isFinite(window.remaining) && window.remaining >= reservePercent);
  })();
  if (value && value !== 'auto') {
    const target = pinned(value, ctx);
    if (!target) return { target: null, explicit: true, skipped: [{ reason: `The ${ROLE_NAMES[role]} model "${value}" is not available.` }] };
    if (role === 'vision' && target.agent !== 'gemini') return { target: null, explicit: true, skipped: [{ agent: target.agent, reason: 'Screenshot review needs an Antigravity model.' }] };
    if (!usable(target.agent)) return { target: null, explicit: true, skipped: [{ agent: target.agent, reason: `${AGENT_NAMES[target.agent] || target.agent} is not installed or is switched off.` }] };
    if (!enough(target.agent)) return { target: null, explicit: true, skipped: [{ agent: target.agent, reason: `${AGENT_NAMES[target.agent]} is short on quota.` }] };
    return { target, explicit: true, skipped: [] };
  }
  const skipped = [];
  for (const target of candidates(role, ctx)) {
    if (!enough(target.agent)) { skipped.push({ agent: target.agent, reason: 'short on quota' }); continue; }
    return { target, explicit: false, skipped };
  }
  return { target: null, explicit: false, skipped };
}

/** What Automatic would choose right now, for the settings dropdowns ("Automatic: Codex"). */
function describeAuto(role, ctx) {
  const first = candidates(role, ctx)[0];
  return first ? `${AGENT_NAMES[first.agent] || first.agent}${first.label ? ` · ${first.label}` : ''}` : 'Nothing available';
}

/** Dropdown choices for a role: every installed, enabled model that can do it. */
function choicesFor(role, ctx) {
  const usable = agent => ctx.isEnabled(agent) && ctx.installed(agent);
  return ctx.models.filter(entry => usable(entry.agent) && (role !== 'vision' || entry.agent === 'gemini'))
    .map(entry => ({ id: entry.id, label: entry.label || entry.model, agent: entry.agent }));
}

module.exports = { ROLES, ROLE_NAMES, ROLE_HINTS, AGENT_NAMES, FLASH, resolveRole, describeAuto, choicesFor, candidates, bestFlash };
