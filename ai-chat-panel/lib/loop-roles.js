'use strict';

// Who does what in a loop. Four roles, each a model choice the user can pin or leave on Automatic:
//   scout         reads and judges text: the ten finders, the verifiers and the fix judges (no edits)
//   editor        makes backend fixes in the loop's private copy
//   visualEditor  makes layout and styling fixes
//   vision        looks at screenshots (needs the Antigravity CLI, the only one that can open an image file headlessly)
// Automatic follows what is installed and enabled. Scouts are Gemini 4 Hydrogen (High) when Antigravity has it, else the newest Flash:
// both draw on the ordinary Gemini pool. Argon, Carbon and Orchestrator are never picked automatically (their weekly pool is small).
// Gemini is never chosen as an editor while Claude Code or Codex is available; it edits when the user picks it, or when nothing else
// can. Editors are Claude Sonnet first, so the expensive models only see the one finding they fix; a second attempt at the same
// finding escalates to Opus, and Codex is the fallback.

const ROLES = ['scout', 'editor', 'visualEditor', 'vision'];
const ROLE_NAMES = { scout: 'Scouts and verifiers', editor: 'Editor (backend fixes)', visualEditor: 'Editor (visual fixes)', vision: 'Screenshot review' };
const ROLE_HINTS = {
  scout: 'Reads the project, finds problems and checks each one. Never edits files. Automatic is Gemini 4 Hydrogen (High), then the newest Flash.',
  editor: 'Makes the fixes for logic, data and tooling problems in the loop’s private copy. Automatic is Claude Sonnet, Opus for a second attempt, then Codex.',
  visualEditor: 'Makes the fixes for layout and styling problems.',
  vision: 'Looks at screenshots of your pages. Needs the Antigravity CLI.',
};
const FLASH = /^gemini-([\d.]+)-flash(?:-(low|medium|high))?$/;
const HYDROGEN = /^gemini-([\d.]+)-hydrogen(?:-(low|medium|high|xhigh))?$/;
const AGENT_NAMES = { gemini: 'Gemini', claude: 'Claude', codex: 'Codex' };

const versionOf = model => Number((FLASH.exec(model)?.[1] || '0').split('.').reduce((sum, part, index) => sum + Number(part) / 100 ** index, 0));
const effortOf = model => ({ high: 3, medium: 2, low: 1 })[FLASH.exec(model)?.[2]] || 0;

// High is the best scout setting: xhigh scored 3 points higher on Artificial Analysis' index at about 1.7x the cost per task, and low scores below Flash.
const hydrogenEffort = model => ({ high: 4, medium: 3, xhigh: 2, low: 1 })[HYDROGEN.exec(model)?.[2]] || 0;
/** True for the Gemini models a scout may use automatically: Flash and Hydrogen, never Argon, Carbon or an Orchestrator. */
const isScoutModel = model => FLASH.test(model || '') || HYDROGEN.test(model || '');

/** Best Gemini Flash in the catalog: newest version, then highest effort. */
function bestFlash(models) {
  return models.filter(entry => entry.agent === 'gemini' && FLASH.test(entry.model))
    .sort((a, b) => versionOf(b.model) - versionOf(a.model) || effortOf(b.model) - effortOf(a.model))[0] || null;
}
/** Best scout in the catalog: Hydrogen at High when the CLI has it, otherwise the newest Flash. */
function bestScout(models) {
  const hydrogen = models.filter(entry => entry.agent === 'gemini' && HYDROGEN.test(entry.model))
    .sort((a, b) => versionOf(b.model) - versionOf(a.model) || hydrogenEffort(b.model) - hydrogenEffort(a.model))[0];
  return hydrogen || bestFlash(models);
}
/** The newest model of a Claude family (sonnet, opus) in the catalog, comparing the numbers in its name. */
function claudeFamily(models, family) {
  const numbers = model => (String(model).match(/\d+/g) || []).map(Number);
  const newer = (a, b) => { const x = numbers(a.model), y = numbers(b.model); for (let i = 0; i < Math.max(x.length, y.length); i++) if ((y[i] || 0) !== (x[i] || 0)) return (y[i] || 0) - (x[i] || 0); return 0; };
  return models.filter(entry => entry.agent === 'claude' && new RegExp(family, 'i').test(entry.model)).sort(newer)[0] || null;
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
function candidates(role, ctx, { escalate = false } = {}) {
  const usable = agent => ctx.isEnabled(agent) && ctx.installed(agent);
  const model = agent => usable(agent) ? entryTarget(ctx.defaultModel(agent)) : null;
  const legacy = ctx.legacy || {};
  const list = [];
  if (role === 'scout') {
    if (usable('gemini')) list.push(entryTarget(bestScout(ctx.models)));
    for (const agent of ['claude', 'codex']) if (usable(agent)) list.push(entryTarget(readerOf(agent, ctx.models, ctx.defaultModel)));
    // The default Gemini model is a last resort, and only when a scout may use it: it could be Argon, whose weekly pool is small.
    if (usable('gemini') && isScoutModel(ctx.defaultModel('gemini')?.model)) list.push(entryTarget(ctx.defaultModel('gemini')));
  } else if (role === 'vision') {
    if (usable('gemini')) list.push(entryTarget(bestFlash(ctx.models) || bestScout(ctx.models)) || entryTarget(ctx.defaultModel('gemini')));
  } else {
    const first = role === 'visualEditor' ? legacy.visualAgent || 'claude' : legacy.backendAgent || 'claude';
    const order = [first, ...['claude', 'codex'].filter(agent => agent !== first)];
    // Claude edits with Sonnet, which sees only the finding it is given; the second attempt at the same finding escalates to Opus.
    const claudeEditor = () => usable('claude') ? entryTarget((escalate ? claudeFamily(ctx.models, 'opus') : null) || claudeFamily(ctx.models, 'sonnet') || ctx.defaultModel('claude')) : null;
    for (const agent of order) { const target = agent === 'claude' ? claudeEditor() : model(agent); if (target) list.push(target); }
    // Gemini only edits when it is all there is; picking it on purpose is the explicit path in resolveRole.
    if (!list.length && usable('gemini')) list.push(entryTarget(ctx.defaultModel('gemini')));
  }
  return list.filter(Boolean);
}

/** A pinned value is a model id, or an agent id meaning that agent's default model. */
function pinned(value, ctx) {
  const entry = ctx.models.find(model => model.id === value || model.model === value);
  if (entry) return entryTarget(entry);
  if (AGENT_NAMES[value]) return entryTarget(value === 'gemini' && bestScout(ctx.models) || ctx.defaultModel(value));
  return null;
}

/**
 * Picks the model for a role. `quotas` (agent -> reading) and `reservePercent` skip an agent that is short on quota, unless it is
 * the only choice the user made. Returns `{target, explicit, skipped}`; `target` is null when nothing can do the job.
 */
function resolveRole(role, ctx, { value = 'auto', quotas = null, reservePercent = 0, escalate = false } = {}) {
  const usable = agent => ctx.isEnabled(agent) && ctx.installed(agent);
  const windowsOf = agent => quotas?.[agent] ? [quotas[agent], quotas[agent].secondary].filter(Boolean) : [];
  const enough = agent => !quotas || !reservePercent || agent === 'gemini' || (() => {
    const reading = quotas[agent];
    return Boolean(reading) && windowsOf(agent).every(window => Number.isFinite(window.remaining) && window.remaining >= reservePercent);
  })();
  // When an agent is short: the moment its last short window resets (epoch ms), so a caller can wait for it instead of retrying blindly.
  const retryAt = agent => {
    const times = windowsOf(agent).filter(window => !(window.remaining >= reservePercent) && Number.isFinite(window.resetsAt)).map(window => window.resetsAt * 1000);
    return times.length ? Math.max(...times) : null;
  };
  if (value && value !== 'auto') {
    const target = pinned(value, ctx);
    if (!target) return { target: null, explicit: true, skipped: [{ reason: `The ${ROLE_NAMES[role]} model "${value}" is not available.` }] };
    if (role === 'vision' && target.agent !== 'gemini') return { target: null, explicit: true, skipped: [{ agent: target.agent, reason: 'Screenshot review needs an Antigravity model.' }] };
    if (!usable(target.agent)) return { target: null, explicit: true, skipped: [{ agent: target.agent, reason: `${AGENT_NAMES[target.agent] || target.agent} is not installed or is switched off.` }] };
    if (!enough(target.agent)) return { target: null, explicit: true, skipped: [{ agent: target.agent, reason: `${AGENT_NAMES[target.agent]} is short on quota.`, quota: true, retryAt: retryAt(target.agent) }] };
    return { target, explicit: true, skipped: [] };
  }
  const skipped = [];
  for (const target of candidates(role, ctx, { escalate })) {
    if (!enough(target.agent)) { skipped.push({ agent: target.agent, reason: 'short on quota', quota: true, retryAt: retryAt(target.agent) }); continue; }
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

module.exports = { ROLES, ROLE_NAMES, ROLE_HINTS, AGENT_NAMES, FLASH, HYDROGEN, resolveRole, describeAuto, choicesFor, candidates, bestFlash, bestScout, claudeFamily, isScoutModel };
