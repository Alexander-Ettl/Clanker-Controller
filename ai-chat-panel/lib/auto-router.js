'use strict';

const { MODEL_CATALOG, quotaFor: catalogQuotaFor } = require('./model-catalog.js');
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const quotaFor = (model, quotas) => catalogQuotaFor(quotas, model);
function lowQuota(entry) {
  return [entry, entry?.secondary].some(window => typeof window?.remaining === 'number' && window.remaining < 15);
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

// Offline fallback uses task complexity and discovered effort, never model/provider names or fixed roles.
function fallback(prompt, models, quotas) {
  const target = /\b(architecture|architect|complex|deep|reason|security|audit|migration|refactor|debug|investigate)\b/i.test(prompt) ? 5
    : /\b(typo|rename|translate|quick|simple|brief)\b/i.test(prompt) ? 2 : 4;
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
