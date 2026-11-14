'use strict';

// Shared by the extension and the disposable cloud runner. All wall-clock decisions use the saved IANA timezone.
const HOUR = 3600000;
const SUPPORTED = ['claude', 'codex'];
const defaults = () => ({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', leadHours: 3,
  days: Array.from({ length: 7 }, (_, day) => ({ enabled: day > 0 && day < 6, start: 9, end: 18 })) });

function plan(value = defaults()) {
  if (!value || typeof value !== 'object') throw Error('Choose a weekly work calendar.');
  try { new Intl.DateTimeFormat('en', { timeZone: value.timezone }).format(); } catch { throw Error('Choose a valid IANA timezone, such as Europe/Berlin.'); }
  if (!Number.isInteger(value.leadHours) || value.leadHours < 1 || value.leadHours > 4) throw Error('Start windows between one and four hours before work.');
  if (!Array.isArray(value.days) || value.days.length !== 7) throw Error('The calendar must contain all seven days.');
  const days = value.days.map(d => {
    if (!d || typeof d.enabled !== 'boolean' || !Number.isInteger(d.start) || !Number.isInteger(d.end) || d.start < 0 || d.start > 23 || d.end < 1 || d.end > 24 || d.start >= d.end) throw Error('Work hours must start and end on the hour, within the same day.');
    // A morning warmup on the previous date would be surprising when a day is unchecked.
    if (d.enabled && d.start < value.leadHours) throw Error('Work must start after the early-start offset. Overnight shifts are not supported yet.');
    return { enabled: d.enabled, start: d.start, end: d.end };
  });
  return { timezone: value.timezone, leadHours: value.leadHours, days };
}

function slots(schedule, day) {
  const d = schedule.days[day];
  if (!d.enabled) return [];
  const hours = [];
  for (let h = d.start - schedule.leadHours; h < d.end; h += 5) hours.push(h);
  return hours;
}

function localTime(schedule, now = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: schedule.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' }).formatToParts(now).map(p => [p.type, p.value]));
  return { day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday), hour: Number(p.hour), minute: Number(p.minute), date: `${p.year}-${p.month}-${p.day}` };
}

function due(schedule, now = Date.now()) {
  const t = localTime(schedule, now);
  // A delayed scheduler invocation never replays an old morning prompt during a quiet period.
  return t.minute < 15 && slots(schedule, t.day).includes(t.hour) ? `${t.date}/${t.hour}` : null;
}

function estimate(schedule, count) {
  const callsPerWeek = schedule.days.reduce((n, _, d) => n + slots(schedule, d).length, 0) * count;
  // One hourly job (minimum one billable minute) + up to 90s for each CLI invocation. Conservative 31-day month.
  return { callsPerWeek, cpuSeconds: 31 * 24 * 60 + Math.ceil(callsPerWeek * 31 / 7) * 90,
    note: 'Estimate only. Other projects share Google’s free allowance. Builds, storage, networking, retries and configuration can incur charges. Budget alerts do not cap spending.' };
}

function credential(agent, data) {
  if (agent === 'claude' && typeof data === 'string' && /^sk-ant-oat\d+-[A-Za-z0-9_-]+$/.test(data.trim())) return data.trim();
  if (agent === 'codex' && data && /^chatgpt/.test(data.auth_mode || '') && !data.OPENAI_API_KEY && data.tokens?.refresh_token && data.tokens?.access_token) return { auth_mode: data.auth_mode, tokens: data.tokens };
  throw Error('Only subscription credentials are accepted. API keys are never used for cloud warmups.');
}

module.exports = { HOUR, SUPPORTED, defaults, plan, slots, due, localTime, estimate, credential };
