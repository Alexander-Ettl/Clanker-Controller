// Average pace in the current quota window. Pure, shared by the rail and tests.
(function (root) {
  'use strict';
  function estimate(quota, now = Date.now()) {
    if (!quota || quota.stale || quota.assumedReset ||
        !Number.isFinite(quota.remaining) || !Number.isFinite(quota.resetsAt) ||
        !(quota.windowMinutes > 0)) return null;
    const reset = quota.resetsAt * 1000;
    const elapsed = now - (reset - quota.windowMinutes * 60000);
    if (reset <= now || elapsed < 60000) return null;
    const remaining = Math.max(0, Math.min(100, quota.remaining));
    const spent = 100 - remaining;
    if (spent === 0) return null;
    const perHour = spent * 3600000 / elapsed;
    const minutesLeft = remaining / perHour * 60;
    return { perHour, minutesLeft, resetsFirst: minutesLeft * 60000 >= reset - now };
  }
  function describe(quota, now = Date.now()) {
    const burn = estimate(quota, now);
    if (!burn) return 'Measuring burn rate…';
    if (burn.minutesLeft === 0) return 'Usage exhausted';
    const minutes = Math.max(1, Math.round(burn.minutesLeft));
    const hours = Math.floor(minutes / 60);
    const duration = hours ? `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ''}` : `${minutes}m`;
    const rate = `${Number(burn.perHour.toFixed(1))}%/h`;
    return burn.resetsFirst ? `Lasts until reset · ${rate}` : `≈ ${duration} left · ${rate}`;
  }
  const api = { estimate, describe };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.burnRate = api;
})(typeof window === 'object' ? window : globalThis);
