// How the "API value" is written (pay-per-token API prices for the work done on subscriptions: a comparison, never a
// bill). Pure; window.apiValue in the webviews, require() in the tests.
(function (root) {
  'use strict';

  /** "$0.42", "$18.50", "$184", "$1.3k", "$12k". Under a cent: "<$0.01". */
  function formatUsd(usd) {
    const n = Number(usd) || 0;
    if (n <= 0) return '$0';
    if (n < 0.01) return '<$0.01';
    if (n < 100) return `$${n.toFixed(2)}`;
    if (n < 1000) return `$${Math.round(n)}`;
    if (n < 10000) return `$${(n / 1000).toFixed(1)}k`;
    return `$${Math.round(n / 1000)}k`;
  }

  // The providers' billing is not fully known (cache tiers, plan discounts, rounding), so every figure is an estimate.
  const SPREAD = 0.2;

  /** "$0.8k – $1.2k": the figure plus and minus the spread. */
  function formatRange(usd, spread = SPREAD) {
    return `${formatUsd(usd * (1 - spread))} – ${formatUsd(usd * (1 + spread))}`;
  }

  const api = { formatUsd, formatRange, SPREAD };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.apiValue = api;
})(typeof window !== 'undefined' ? window : globalThis);
