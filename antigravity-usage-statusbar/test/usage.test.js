'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  findLatestCodexRateLimit,
  formatCompactReset,
  formatReset,
  formatStatus,
  formatUsageTooltip,
  formatVisualStatus,
  parseClaudeCache,
  parseClaudeFiveHourState,
  parseClaudeWeeklyState,
  renderGauge,
} = require('../usage');

test('parses the Claude cache contract', () => {
  assert.deepEqual(
    parseClaudeCache({
      model: 'Opus',
      hasData: true,
      used: 42,
      remaining: 58,
      resetsAt: 1_789_638_829,
      updatedAt: 1_789_631_630_007,
    }),
    {
      model: 'Opus',
      used: 42,
      remaining: 58,
      resetsAt: 1_789_638_829,
      updatedAt: 1_789_631_630_007,
      windowMinutes: 300,
    },
  );
});

test('returns no Claude usage when hasData is false', () => {
  assert.equal(parseClaudeCache({ hasData: false }), null);
});

test('parses Claude five-hour usage from local state', () => {
  assert.deepEqual(
    parseClaudeFiveHourState({
      cachedUsageUtilization: {
        fetchedAtMs: 1_789_835_941_688,
        utilization: {
          five_hour: {
            utilization: 1,
            resets_at: '2026-09-19T21:29:59.000Z',
          },
        },
      },
    }),
    {
      model: null,
      used: 1,
      remaining: 99,
      resetsAt: Date.parse('2026-09-19T21:29:59.000Z') / 1000,
      updatedAt: 1_789_835_941_688,
      windowMinutes: 300,
    },
  );
});

test('reads an idle Claude five-hour window (no reset yet) as full', () => {
  const parsed = parseClaudeFiveHourState({
    cachedUsageUtilization: {
      fetchedAtMs: 1_790_228_687_464,
      utilization: { five_hour: { utilization: 0, resets_at: null } },
    },
  });
  assert.equal(parsed.used, 0);
  assert.equal(parsed.remaining, 100);
  assert.equal(parsed.resetsAt, null);
});

test('parses Claude weekly usage from local state', () => {
  assert.deepEqual(
    parseClaudeWeeklyState({
      cachedUsageUtilization: {
        utilization: {
          seven_day: {
            utilization: 96,
            resets_at: '2026-09-18T13:00:00.000Z',
          },
        },
      },
    }),
    {
      used: 96,
      remaining: 4,
      resetsAt: Date.parse('2026-09-18T13:00:00.000Z') / 1000,
      windowMinutes: 10080,
    },
  );
});

test('P17-B: parses the Opus-only weekly cap, and nothing when the plan has none', () => {
  const state = (opus) => ({ cachedUsageUtilization: { utilization: { seven_day: { utilization: 20, resets_at: '2026-09-20T09:00:00.000Z' }, seven_day_opus: opus } } });
  assert.deepEqual(parseClaudeWeeklyState(state({ utilization: 42, resets_at: '2026-09-21T09:00:00.000Z' }), 'seven_day_opus'), {
    used: 42,
    remaining: 58,
    resetsAt: Date.parse('2026-09-21T09:00:00.000Z') / 1000,
    windowMinutes: 10080,
  });
  assert.equal(parseClaudeWeeklyState(state(null), 'seven_day_opus'), null);
  assert.equal(parseClaudeWeeklyState(state(null)).used, 20, 'the default key is still the all-models week');
});

test('extracts the latest Codex rate-limit snapshot from rollout JSONL', () => {
  const first = JSON.stringify({
    timestamp: '2026-09-17T07:40:25.141Z',
    payload: {
      rate_limits: {
        primary: { used_percent: 6, window_minutes: 300, resets_at: 1_789_648_193 },
      },
    },
  });
  const second = JSON.stringify({
    timestamp: '2026-09-17T08:08:30.257Z',
    payload: {
      rate_limits: {
        primary: { used_percent: 19, window_minutes: 300, resets_at: 1_789_648_193 },
        secondary: { used_percent: 3, window_minutes: 10080, resets_at: 1_790_234_993 },
        plan_type: 'plus',
      },
    },
  });

  assert.deepEqual(findLatestCodexRateLimit(`${first}\n${second}\n`), {
    used: 19,
    remaining: 81,
    windowMinutes: 300,
    resetsAt: 1_789_648_193,
    secondary: {
      used: 3,
      remaining: 97,
      windowMinutes: 10080,
      resetsAt: 1_790_234_993,
    },
    observedAt: '2026-09-17T08:08:30.257Z',
    planType: 'plus',
  });
});

test('formats status text and reset durations', () => {
  const now = Date.UTC(2026, 8, 17, 8, 0, 0);
  const resetsAt = now / 1000 + 2 * 60 * 60 + 17 * 60;
  const usage = { used: 42, remaining: 58, windowMinutes: 300, resetsAt };
  const weekly = {
    used: 96,
    remaining: 4,
    windowMinutes: 10080,
    resetsAt: now / 1000 + 24 * 60 * 60 + 3 * 60 * 60,
  };

  assert.equal(formatReset(resetsAt, now), '2h 17m');
  assert.equal(formatCompactReset(resetsAt, now), '2h17m');
  assert.equal(
    formatStatus('Claude', usage, now),
    'Claude 5h: 42% used (58% left, resets 2h 17m)',
  );
  assert.equal(
    formatVisualStatus('Claude', usage, weekly, now),
    'Claude   ▰▰▰▱▱58%   $(history) 2h17m',
  );
  assert.equal(
    formatVisualStatus('Claude', usage, now),
    'Claude   ▰▰▰▱▱58%   $(history) 2h17m',
  );
});

test('formats rich graphical Markdown tooltip with table and gauges', () => {
  const now = Date.UTC(2026, 8, 17, 8, 0, 0);
  const primary = {
    used: 40,
    remaining: 60,
    windowMinutes: 300,
    resetsAt: now / 1000 + 3 * 3600 + 22 * 60,
  };
  const secondary = {
    used: 7,
    remaining: 93,
    windowMinutes: 10080,
    resetsAt: now / 1000 + 6 * 86400 + 22 * 3600,
  };

  const md = formatUsageTooltip({
    title: 'Gemini Models (Antigravity)',
    icon: 'sparkle',
    subtitle: 'Google AI Pro',
    primary,
    secondary,
    description: 'Shared quota pool across Gemini models.',
    meta: ['$(server) **Source:** `Language Server`'],
    nowMs: now,
  });

  assert.match(md, /### \$\(sparkle\) Gemini Models \(Antigravity\)/);
  assert.match(md, /\| \*\*5-Hour Limit\*\* \| `▰▰▰▰▰▰▱▱▱▱` \| \*\*60%\*\* \| 40% \| `3h 22m` \|/);
  assert.match(md, /\| \*\*Weekly Limit \(7d\)\*\* \| `▰▰▰▰▰▰▰▰▰▱` \| \*\*93%\*\* \| 7% \| `6d 22h` \|/);
  assert.match(md, /> Shared quota pool across Gemini models\./);
  assert.match(md, /\$\(server\) \*\*Source:\*\* `Language Server`/);
});

test('P11-I: labels a weekly bucket "Weekly Limit (7d)" when it is promoted into the primary slot', () => {
  const now = Date.now();
  const weeklyAsPrimary = {
    used: 71,
    remaining: 29,
    windowMinutes: 10080,
    resetsAt: now / 1000 + 6 * 86400 + 22 * 3600,
  };

  const md = formatUsageTooltip({
    title: 'Gemini Models (Antigravity)',
    primary: weeklyAsPrimary,
    secondary: null,
    nowMs: now,
  });

  assert.match(md, /\| \*\*Weekly Limit \(7d\)\*\* \| `▰▰▰▱▱▱▱▱▱▱` \| \*\*29%\*\* \| 71% \| `6d 22h` \|/);
});

test('renders a five-dot usage gauge', () => {
  assert.equal(renderGauge(0), '▱▱▱▱▱');
  assert.equal(renderGauge(1), '▱▱▱▱▱');
  assert.equal(renderGauge(25), '▰▱▱▱▱');
  assert.equal(renderGauge(58), '▰▰▰▱▱');
  assert.equal(renderGauge(100), '▰▰▰▰▰');
});

test('ignores malformed rollout data', () => {
  assert.equal(findLatestCodexRateLimit('{not json}\n'), null);
});

test('a window past its reset time reads as refilled, its unexpired 7d window is kept', () => {
  const Module = require('node:module');
  const orig = Module._load;
  Module._load = function (request, ...rest) { return request === 'vscode' ? {} : orig.call(this, request, ...rest); };
  try {
    const { refilled } = require('../extension.js');
    const now = 1_000_000_000;
    assert.deepEqual(refilled({ used: 70, remaining: 30, resetsAt: now / 1000 - 60, windowMinutes: 300 }, now), { used: 0, remaining: 100, resetsAt: null, windowMinutes: 300 });
    const live = { used: 81, remaining: 19, resetsAt: now / 1000 + 60, windowMinutes: 10080 };
    assert.equal(refilled(live, now), live);
    assert.equal(refilled(null, now), null);
  } finally { Module._load = orig; }
});

test('Linux: antigravity-usage-statusbar discovers language server and ports from /proc and ss', async () => {
  const { discoverLinux } = require('../antigravity.js');
  const found = await discoverLinux({
    readdir: () => ['1', '42', '99', 'self'],
    readFile: (file) => {
      if (file === '/proc/42/cmdline') return '/opt/antigravity/language_server_linux_x64\0--enable_lsp\0--csrf_token=dead-beef\0';
      if (file === '/proc/99/cmdline') return '/usr/bin/node\0server.js\0';
      throw new Error('EACCES');
    },
    exec: async () => 'LISTEN 0 128 127.0.0.1:41234 0.0.0.0:* users:(("language_server",pid=42,fd=7))\nLISTEN 0 128 127.0.0.1:8080 0.0.0.0:* users:(("node",pid=99,fd=5))\n',
  });
  assert.deepEqual(found, {
    procs: [{ ProcessId: 42, CommandLine: '/opt/antigravity/language_server_linux_x64 --enable_lsp --csrf_token=dead-beef' }],
    ports: [41234],
  });
});
