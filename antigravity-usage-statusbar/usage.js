'use strict';

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function percent(value) {
  const number = finiteNumber(value);
  if (number === null) return null;
  return Math.round(Math.min(100, Math.max(0, number)));
}

function formatWindow(minutes) {
  const value = finiteNumber(minutes);
  if (value === null || value <= 0) return 'usage';
  if (value % 1440 === 0) return `${value / 1440}d`;
  if (value % 60 === 0) return `${value / 60}h`;
  return `${Math.round(value)}m`;
}

function formatReset(resetsAtSeconds, nowMs = Date.now()) {
  const resetsAt = finiteNumber(resetsAtSeconds);
  if (resetsAt === null) return 'unknown';

  const remainingMinutes = Math.max(
    0,
    Math.ceil((resetsAt * 1000 - nowMs) / 60000),
  );
  if (remainingMinutes === 0) return 'now';

  const days = Math.floor(remainingMinutes / 1440);
  const hours = Math.floor((remainingMinutes % 1440) / 60);
  const minutes = remainingMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatCompactReset(resetsAtSeconds, nowMs = Date.now()) {
  const resetsAt = finiteNumber(resetsAtSeconds);
  if (resetsAt === null) return '--';

  const remainingMinutes = Math.max(
    0,
    Math.ceil((resetsAt * 1000 - nowMs) / 60000),
  );
  if (remainingMinutes === 0) return 'now';

  const days = Math.floor(remainingMinutes / 1440);
  const hours = Math.floor((remainingMinutes % 1440) / 60);
  const minutes = remainingMinutes % 60;
  if (days > 0) return `${days}d${hours > 0 ? `${hours}h` : ''}`;
  if (hours > 0) return `${hours}h${minutes > 0 ? `${minutes}m` : ''}`;
  return `${minutes}m`;
}

function formatStatus(label, usage, nowMs = Date.now()) {
  return `${label} ${formatWindow(usage.windowMinutes)}: ${usage.used}% used (${usage.remaining}% left, resets ${formatReset(usage.resetsAt, nowMs)})`;
}

function renderGauge(value, width = 5) {
  const normalized = percent(value) ?? 0;
  const filledDots = Math.round((normalized / 100) * width);
  return `${'▰'.repeat(filledDots)}${'▱'.repeat(width - filledDots)}`;
}

function formatVisualWindow(usage, nowMs, showGauge = true) {
  if (!usage) {
    const usageDisplay = showGauge ? `${renderGauge(0)}--%` : '--%';
    return `${usageDisplay}   $(history) --`;
  }

  const usageDisplay = showGauge
    ? `${renderGauge(usage.remaining)}${usage.remaining}%`
    : `${usage.remaining}%`;
  return `${usageDisplay}   $(history) ${formatCompactReset(usage.resetsAt, nowMs)}`;
}

function formatVisualStatus(
  label,
  usage,
  secondaryOrNowMs = Date.now(),
  maybeNowMs = Date.now(),
) {
  const nowMs =
    typeof secondaryOrNowMs === 'number' ? secondaryOrNowMs : maybeNowMs;
  return `${label}   ${formatVisualWindow(usage, nowMs, true)}`;
}

function formatUsageTooltip({
  title,
  icon = 'graph',
  subtitle = null,
  primary = null,
  secondary = null,
  description = null,
  meta = [],
  nowMs = Date.now(),
}) {
  const lines = [];

  // Header
  lines.push(`### $(${icon}) ${title}`);
  if (subtitle) {
    lines.push(`*${subtitle}*`);
  }
  lines.push('');

  // Table
  lines.push('| Window | Gauge (10%) | Remaining | Used | Resets In |');
  lines.push('| :--- | :--- | :---: | :---: | :--- |');

  if (primary) {
    const gauge = renderGauge(primary.remaining, 10);
    // P11-I: a weekly-only Antigravity quota response now promotes the
    // weekly bucket into this same `primary` slot (see
    // parseAntigravityQuota's own comment) -- labelled the same way the
    // secondary slot below already labels a weekly bucket, instead of
    // falling through to the generic formatWindow() "7d".
    const windowName =
      primary.windowMinutes === 300
        ? '5-Hour Limit'
        : primary.windowMinutes === 10080
          ? 'Weekly Limit (7d)'
          : formatWindow(primary.windowMinutes);
    lines.push(
      `| **${windowName}** | \`${gauge}\` | **${primary.remaining}%** | ${primary.used}% | \`${formatReset(primary.resetsAt, nowMs)}\` |`,
    );
  } else {
    lines.push('| **5-Hour Limit** | `▱▱▱▱▱▱▱▱▱▱` | `--%` | `--%` | `--` |');
  }

  if (secondary) {
    const gauge = renderGauge(secondary.remaining, 10);
    const windowName =
      secondary.windowMinutes === 10080
        ? 'Weekly Limit (7d)'
        : formatWindow(secondary.windowMinutes);
    lines.push(
      `| **${windowName}** | \`${gauge}\` | **${secondary.remaining}%** | ${secondary.used}% | \`${formatReset(secondary.resetsAt, nowMs)}\` |`,
    );
  }

  lines.push('');

  if (description) {
    lines.push(`> ${description}`);
    lines.push('');
  }

  if (meta && meta.length > 0) {
    lines.push('---');
    lines.push(meta.join(' &nbsp;•&nbsp; '));
  }

  return lines.join('\n');
}

function parseClaudeCache(value) {
  if (!value || value.hasData !== true) return null;

  const used = percent(value.used);
  const resetsAt = finiteNumber(value.resetsAt);
  if (used === null || resetsAt === null) return null;

  const suppliedRemaining = percent(value.remaining);
  return {
    model: typeof value.model === 'string' ? value.model : null,
    used,
    remaining: suppliedRemaining === null ? 100 - used : suppliedRemaining,
    resetsAt,
    updatedAt: finiteNumber(value.updatedAt),
    windowMinutes: 300,
  };
}

function parseClaudeFiveHourState(value) {
  const fiveHour = value?.cachedUsageUtilization?.utilization?.five_hour;
  if (!fiveHour) return null;

  const used = percent(fiveHour.utilization ?? fiveHour.used_percentage);
  const reset = fiveHour.resets_at ?? fiveHour.resetsAt;
  const resetMilliseconds = Date.parse(reset);
  // No reset time means no window is running yet (nothing used): full, not unknown.
  if (used === null || (reset != null && !Number.isFinite(resetMilliseconds))) return null;

  const fetchedAt = finiteNumber(value?.cachedUsageUtilization?.fetchedAtMs);

  return {
    model: null,
    used,
    remaining: 100 - used,
    resetsAt: reset == null ? null : resetMilliseconds / 1000,
    updatedAt: fetchedAt,
    windowMinutes: 300,
  };
}

// P17-B: `key` 'seven_day_opus' reads the account's Opus-only weekly cap
// (reported alongside the all-models `seven_day`; null on plans without one).
function parseClaudeWeeklyState(value, key = 'seven_day') {
  const weekly = value?.cachedUsageUtilization?.utilization?.[key];
  if (!weekly) return null;

  const used = percent(weekly.utilization ?? weekly.used_percentage);
  const resetMilliseconds = Date.parse(weekly.resets_at ?? weekly.resetsAt);
  if (used === null || !Number.isFinite(resetMilliseconds)) return null;

  return {
    used,
    remaining: 100 - used,
    resetsAt: resetMilliseconds / 1000,
    windowMinutes: 7 * 24 * 60,
  };
}

function normalizeWindow(window) {
  if (!window) return null;

  const used = percent(window.used_percent ?? window.usedPercent);
  const windowMinutes = finiteNumber(
    window.window_minutes ?? window.windowDurationMins,
  );
  const resetsAt = finiteNumber(window.resets_at ?? window.resetsAt);
  if (used === null || windowMinutes === null || resetsAt === null) return null;

  return { used, remaining: 100 - used, windowMinutes, resetsAt };
}

function parseCodexRateLimitLine(line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }

  const rateLimits =
    event?.payload?.rate_limits ??
    event?.payload?.rateLimits ??
    event?.payload?.info?.rate_limits ??
    event?.payload?.info?.rateLimits ??
    event?.rate_limits ??
    event?.rateLimits ??
    null;
  const primary = normalizeWindow(rateLimits?.primary);
  if (!primary) return null;

  return {
    ...primary,
    secondary: normalizeWindow(rateLimits.secondary),
    observedAt: typeof event.timestamp === 'string' ? event.timestamp : null,
    planType: rateLimits.plan_type ?? rateLimits.planType ?? null,
  };
}

function findLatestCodexRateLimit(text) {
  const lines = text.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.includes('rate_limits') && !line.includes('rateLimits')) continue;
    const usage = parseCodexRateLimitLine(line);
    if (usage) return usage;
  }
  return null;
}

function normalizeAntigravityBucket(bucket) {
  if (!bucket || typeof bucket !== 'object') return null;
  const rawReset = bucket.resetTime ?? bucket.reset_time;
  const resetMs = typeof rawReset === 'number'
    ? (rawReset > 1e12 ? rawReset : rawReset * 1000)
    : Date.parse(rawReset);
  const resetsAt = Number.isFinite(resetMs) ? resetMs / 1000 : null;
  const description = bucket.description ?? null;

  const rawFraction = bucket.remainingFraction ?? bucket.remaining_fraction;
  let remainingFraction = finiteNumber(rawFraction);
  if (
    remainingFraction === null &&
    rawFraction == null &&
    (resetsAt !== null || /hit your .* limit|exhausted|depleted|\b0%/i.test(String(description || '')))
  ) {
    remainingFraction = 0;
  }
  if (remainingFraction === null) return null;

  const remaining = percent(remainingFraction * 100);
  if (remaining === null) return null;
  const used = 100 - remaining;

  let windowMinutes = 300;
  const bucketId = String(bucket.bucketId ?? bucket.bucket_id ?? '');
  const windowStr = String(bucket.window ?? '');
  if (windowStr === 'weekly' || /weekly|7d/i.test(bucketId)) {
    windowMinutes = 7 * 24 * 60;
  } else if (windowStr === '5h' || /5h|five[_-]?hour/i.test(bucketId)) {
    windowMinutes = 300;
  }

  return {
    used,
    remaining,
    windowMinutes,
    resetsAt: remainingFraction >= 1 && !description ? null : resetsAt,
    displayName: bucket.displayName ?? bucket.display_name ?? null,
    description,
  };
}

function parseAntigravityQuota(data, groupName = 'Gemini Models') {
  if (!data) return null;
  const groups = data.response?.groups ?? data.groups;
  if (!Array.isArray(groups)) return null;

  const want = groupName.toLowerCase();
  let group = groups.find(
    (g) =>
      g.displayName === groupName ||
      (typeof g.displayName === 'string' &&
        g.displayName.toLowerCase().includes(want)),
  );
  if (!group && want.includes('claude')) {
    group = groups.find(
      (g) =>
        Array.isArray(g.buckets) &&
        (g.buckets.some((b) => /^3p[-_]/i.test(String(b?.bucketId ?? b?.bucket_id ?? ''))) ||
          (/\b(?:claude|gpt)\b/i.test(`${g.displayName || ''} ${g.description || ''}`) &&
            !/^gemini\b/i.test(String(g.displayName || '')))),
    );
  }
  if (!group || !Array.isArray(group.buckets)) return null;

  const buckets = group.buckets;
  const fiveHourBucket = buckets.find(
    (b) =>
      b.window === '5h' ||
      String(b.bucketId ?? b.bucket_id ?? '').includes('5h'),
  );
  const weeklyBucket = buckets.find(
    (b) =>
      b.window === 'weekly' ||
      String(b.bucketId ?? b.bucket_id ?? '').includes('weekly'),
  );

  // P11-I: the Antigravity Language Server doesn't always return a 5-hour
  // bucket -- observed returning only a `gemini-weekly` one, with no 5h
  // window at all. Strictly requiring the 5-hour bucket as `primary` threw
  // away real, valid weekly quota data whenever that happened, silently
  // showing "No readable Gemini usage data" even though the RPC response
  // actually had usage to show. Falls back to the weekly bucket as
  // `primary` only when there's truly nothing else; `secondary` stays null
  // in that case since there's only the one window to show, not two.
  const fiveHourUsage = normalizeAntigravityBucket(fiveHourBucket);
  const weeklyUsage = normalizeAntigravityBucket(weeklyBucket);
  const primary = fiveHourUsage ?? weeklyUsage;
  if (!primary) return null;

  const secondary = fiveHourUsage ? weeklyUsage : null;

  return {
    ...primary,
    primary,
    secondary,
    displayName: group.displayName,
    description: group.description,
  };
}

module.exports = {
  findLatestCodexRateLimit,
  formatCompactReset,
  formatReset,
  formatStatus,
  formatUsageTooltip,
  formatVisualStatus,
  formatWindow,
  parseAntigravityQuota,
  parseClaudeCache,
  parseClaudeFiveHourState,
  parseClaudeWeeklyState,
  parseCodexRateLimitLine,
  renderGauge,
};

