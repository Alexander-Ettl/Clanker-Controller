'use strict';

const { MODEL_CATALOG, quotaFor: catalogQuotaFor } = require('./model-catalog.js');
const { categoryFitScore } = require('./model-benchmarks.js');
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const quotaFor = (model, quotas) => catalogQuotaFor(quotas, model);
function lowQuota(entry) {
  return [entry, entry?.secondary].some(window => typeof window?.remaining === 'number' && window.remaining < 15);
}
function minQuotaPct(model, quotas) {
  const entry = quotaFor(model, quotas);
  const vals = [entry?.remaining, entry?.secondary?.remaining].filter((v) => typeof v === 'number' && Number.isFinite(v));
  return vals.length ? Math.min(...vals) : null;
}

function candidates(quotas, available) {
  const favorites = MODEL_CATALOG.filter(model => !available || available.includes(model.agent));
  if (!favorites.length) throw new Error('Add a CLI and favorite a model in Settings > Models to use Auto.');
  const usable = favorites.filter(model => ![quotaFor(model, quotas), quotaFor(model, quotas)?.secondary]
    .some(window => typeof window?.remaining === 'number' && window.remaining <= 0));
  if (!usable.length) throw new Error('All favorite models are out of usage. Wait for a reset or select a model manually.');
  const healthy = usable.filter(model => !lowQuota(quotaFor(model, quotas)));
  return healthy.length ? healthy : usable;
}

function inferCategory(prompt) {
  const text = String(prompt || '');
  if (/\b(visual|design|styling|layout|logo|svg|icon|aesthetic|beautiful|css|ui|frontend)\b/i.test(text)) return { purpose: 'visual', difficulty: 0.55 };
  if (/\b(typo|rename|translate)\b/i.test(text) && !/\b(debug|bug|backend|api|database|server|crash|error|architecture|migration|refactor|security|audit)\b/i.test(text)) return { purpose: 'information', difficulty: 0.2 };
  if (/\b(debug|bug|backend|api|database|server|terminal|cli|crash|error|fix)\b/i.test(text)) return { purpose: 'backend', difficulty: 0.85 };
  if (/\b(architecture|architect|from scratch|new app|new project|migration|refactor|build|complex|deep|reason|security|audit|investigate)\b/i.test(text)) return { purpose: 'build', difficulty: 0.85 };
  if (/\b(quick|simple|brief|documentation|search|research|look up|explain)\b/i.test(text)) return { purpose: 'information', difficulty: 0.2 };
  return { purpose: 'unspecified', difficulty: 0.5 };
}

// Offline fallback uses objective third-party category benchmarks + quota health when available,
// falling back to effort-distance for unknown models.
function fallback(prompt, models, quotas) {
  const { purpose, difficulty } = inferCategory(prompt);
  const scored = models.map((model) => ({
    model,
    score: categoryFitScore(model, { purpose, difficulty, quotaPct: minQuotaPct(model, quotas) }),
  }));
  if (scored.some((entry) => entry.score != null)) {
    return scored.sort((a, b) => (b.score ?? -1) - (a.score ?? -1)
      || (minQuotaPct(b.model, quotas) ?? 50) - (minQuotaPct(a.model, quotas) ?? 50)
      || Number(b.model.isDefault === true) - Number(a.model.isDefault === true))[0].model;
  }
  const target = difficulty >= 0.8 ? 5 : difficulty <= 0.3 ? 2 : 4;
  const distance = model => {
    const effort = model.effort || /(?:[-\s(])(none|minimal|low|medium|high|xhigh|max|ultra)\)?$/i.exec(model.model)?.[1];
    const rank = EFFORTS.indexOf(effort);
    return rank < 0 ? 1 : Math.abs(rank - target);
  };
  return [...models].sort((a, b) => distance(a) - distance(b)
    || Number(b.isDefault === true) - Number(a.isDefault === true)
    || (quotaFor(b, quotas)?.remaining ?? 50) - (quotaFor(a, quotas)?.remaining ?? 50))[0];
}

function dispatch(prompt, model) {
  return { agent: model.agent, modelId: model.id, split: false, contract: '', directive: '', roleName: null, prompt };
}

function route(prompt, quotas = {}, requested = 'auto', available) {
  if (requested !== 'auto') return { agent: requested, split: false, contract: '', directive: '', roleName: null, prompt };
  return dispatch(prompt, fallback(prompt, candidates(quotas, available), quotas));
}

/** One semantic decision over the current favorites; invalid classifier output uses the offline fallback. */
async function routeBest(prompt, quotas = {}, available, choose) {
  const models = candidates(quotas, available);
  let selected;
  if (models.length > 1 && choose) {
    try {
      const id = await choose(prompt, models, quotas);
      // Favorites and CLI connections may change while the classifier is answering.
      selected = candidates(quotas, available).find(model => model.id === id);
    } catch { /* classification is optional; chatting still works offline */ }
  }
  return dispatch(prompt, selected || fallback(prompt, candidates(quotas, available), quotas));
}

module.exports = { route, routeBest, lowQuota };
