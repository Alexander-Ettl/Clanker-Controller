'use strict';

// "/loop 5m check the build" repeats a prompt in this chat; "/loop stop" ends it. The text after /loop is parsed here, in the
// host, so it can be tested; the repeating itself is the scheduler queue's recurrence (lib/scheduler-queue.js).

const USAGE = 'Repeat a prompt: "/loop 5m check the build" (every 5 minutes; units s, m, h). Optional: "--max 6" runs at most 6 times (default 24), "--for 2h" stops after 2 hours (default 7 days). "/loop stop" ends the repeats in this chat.';
const UNIT_MINUTES = { s: 1 / 60, m: 1, h: 60 };

/** "90s", "5m", "2h", "1h30m" as minutes; null if it is none of those. */
function parseInterval(text) {
  const match = /^(?:(\d+(?:\.\d+)?)(s|m|h))+$/i.exec(String(text || '').trim());
  if (!match) return null;
  let minutes = 0;
  for (const part of String(text).matchAll(/(\d+(?:\.\d+)?)(s|m|h)/gi)) minutes += Number(part[1]) * UNIT_MINUTES[part[2].toLowerCase()];
  return minutes;
}

/**
 * The text after "/loop". Returns { action: 'help' | 'stop' } or { action: 'start', everyMinutes, maxRuns?, forMinutes?, prompt }
 * or { error }.
 */
function parseLoopCommand(args) {
  let rest = String(args || '').trim();
  if (!rest || /^(help|\?)$/i.test(rest)) return { action: 'help' };
  if (/^(stop|cancel|off)$/i.test(rest)) return { action: 'stop' };
  const first = /^(\S+)\s*/.exec(rest);
  const everyMinutes = parseInterval(first[1]);
  if (everyMinutes === null) return { error: `"${first[1]}" is not an interval. ${USAGE}` };
  if (everyMinutes < 1 || everyMinutes > 1440) return { error: `The interval has to be between 1 minute and 24 hours. ${USAGE}` };
  rest = rest.slice(first[0].length);
  const out = { action: 'start', everyMinutes };
  for (;;) {
    const flag = /^--(max|for)(?:=|\s+)(\S+)\s*/i.exec(rest);
    if (!flag) break;
    if (flag[1].toLowerCase() === 'max') {
      const runs = Number(flag[2]);
      if (!Number.isInteger(runs) || runs < 1) return { error: '--max takes a whole number of runs, like "--max 6".' };
      out.maxRuns = runs;
    } else {
      const minutes = parseInterval(flag[2]);
      if (minutes === null) return { error: '--for takes a duration, like "--for 2h".' };
      out.forMinutes = minutes;
    }
    rest = rest.slice(flag[0].length);
  }
  out.prompt = rest.trim();
  if (!out.prompt) return { error: `/loop needs a prompt after the interval. ${USAGE}` };
  return out;
}

module.exports = { USAGE, parseInterval, parseLoopCommand };
