// How Manage Chats says when a chat was last active, the way a messenger does: "12 minutes ago" while it is fresh,
// the clock time on the same day ("15:30"), "Yesterday, 15:30", then the date ("Sep 29, 18:56"), and the year once
// the chat is a year old or more ("Sep 29, 2025"). Also the day groups the list is divided into. Pure functions
// (no DOM), loaded by the webview as window.chatTime and by the unit test through require.
(function (root) {
  'use strict';

  const DAY = 864e5;
  const RELATIVE_HOURS = 3; // "2 hours ago" up to here, then the clock time
  const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  const MONTH = { month: 'short' };

  /** Whole calendar days between `at` and `now`: 0 today, 1 yesterday. */
  function daysAgo(at, now) {
    return Math.round((startOfDay(new Date(now)) - startOfDay(new Date(at))) / DAY);
  }

  /**
   * @param {string|number|Date} when
   * @param {{ now?: number, locale?: string, hourCycle?: string, compact?: boolean }} [options] hourCycle: 'h23' | 'h12' | undefined (the locale's own);
   *   compact: the short form for the narrow rail ("4 min ago", "Yesterday", "Sep 28", "Sep 2025"), no clock on older days
   */
  function chatTime(when, { now = Date.now(), locale, hourCycle, compact = false } = {}) {
    const at = new Date(when).getTime();
    if (Number.isNaN(at)) return '';
    const minutes = Math.max(0, Math.floor((now - at) / 60000)); // a clock a little ahead reads as "just now"
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return compact ? `${minutes} min ago` : plural(minutes, 'minute');
    if (minutes < RELATIVE_HOURS * 60) return compact ? `${Math.floor(minutes / 60)} hr ago` : plural(Math.floor(minutes / 60), 'hour');
    const date = new Date(at);
    const clock = date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', ...(hourCycle ? { hourCycle } : {}) });
    const days = daysAgo(at, now);
    if (days <= 0) return clock;
    if (days === 1) return compact ? 'Yesterday' : `Yesterday, ${clock}`;
    if (compact) return date.toLocaleDateString(locale, now - at >= 365 * DAY ? { ...MONTH, year: 'numeric' } : { ...MONTH, day: 'numeric' });
    if (now - at >= 365 * DAY) return date.toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
    return `${date.toLocaleDateString(locale, { month: 'short', day: 'numeric' })}, ${clock}`;
  }

  /** The stamp on a message: the clock time today, "Yesterday, 15:30", then "Sep 29, 18:56" ("Sep 29, 2025, 18:56" from another year). */
  function messageTime(when, { now = Date.now(), locale, hourCycle } = {}) {
    const at = new Date(when).getTime();
    if (Number.isNaN(at)) return '';
    const date = new Date(at);
    const clock = date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', ...(hourCycle ? { hourCycle } : {}) });
    const days = daysAgo(at, now);
    if (days <= 0) return clock;
    if (days === 1) return `Yesterday, ${clock}`;
    const sameYear = date.getFullYear() === new Date(now).getFullYear();
    return `${date.toLocaleDateString(locale, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })}, ${clock}`;
  }

  /** The heading of the day group a chat falls under: Today, Yesterday, Last 7 days, Last 30 days, then by month. */
  function chatDayGroup(when, { now = Date.now(), locale } = {}) {
    const at = new Date(when).getTime();
    if (Number.isNaN(at)) return '';
    const days = daysAgo(at, now);
    if (days <= 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 7) return 'Last 7 days';
    if (days < 30) return 'Last 30 days';
    const date = new Date(at);
    const sameYear = date.getFullYear() === new Date(now).getFullYear();
    return date.toLocaleDateString(locale, sameYear ? { month: 'long' } : { month: 'long', year: 'numeric' });
  }

  const api = { chatTime, chatDayGroup, messageTime };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.chatTime = api;
})(typeof window !== 'undefined' ? window : globalThis);
