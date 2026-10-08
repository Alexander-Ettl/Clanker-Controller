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
  // 95 -> "1h 35m", 40 -> "40m", 3000 -> "2d 2h"
  function duration(minutes) {
    const total = Math.max(1, Math.round(minutes));
    const days = Math.floor(total / 1440), hours = Math.floor(total % 1440 / 60), mins = total % 60;
    if (days) return `${days}d${hours ? ` ${hours}h` : ''}`;
    return hours ? `${hours}h${mins ? ` ${mins}m` : ''}` : `${mins}m`;
  }
  function describe(quota, now = Date.now()) {
    const burn = estimate(quota, now);
    if (!burn) return 'Measuring burn rate…';
    if (burn.minutesLeft === 0) return 'Usage exhausted';
    const rate = `${Number(burn.perHour.toFixed(1))}%/h`;
    return burn.resetsFirst ? `Lasts until reset · ${rate}` : `≈ ${duration(burn.minutesLeft)} left · ${rate}`;
  }
  const api = { estimate, describe, duration };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.burnRate = api;
})(typeof window === 'object' ? window : globalThis);
