'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseAntigravityQuota } = require('../usage');

test('parses Gemini Models quota from Antigravity RPC payload', () => {
  const payload = {
    response: {
      groups: [
        {
          displayName: 'Gemini Models',
          description: 'Models within this group: Gemini Flash, Gemini Pro',
          buckets: [
            {
              bucketId: 'gemini-weekly',
              displayName: 'Weekly Limit Remaining',
              description: 'You have used some of your weekly limit, it will fully refresh in 6 days, 22 hours.',
              window: 'weekly',
              remainingFraction: 0.9396706,
              resetTime: '2026-09-24T10:29:02Z',
            },
            {
              bucketId: 'gemini-5h',
              displayName: 'Five Hour Limit Remaining',
              description: 'You have used some of your 5-hour limit, it will fully refresh in 3 hours, 39 minutes.',
              window: '5h',
              remainingFraction: 0.6380237,
              resetTime: '2026-09-17T15:29:02Z',
            },
          ],
        },
        {
          displayName: 'Claude and GPT models',
          buckets: [
            {
              bucketId: '3p-weekly',
              remainingFraction: 1,
              resetTime: '2026-09-24T11:49:35Z',
            },
            {
              bucketId: '3p-5h',
              remainingFraction: 1,
              resetTime: '2026-09-17T16:49:35Z',
            },
          ],
        },
      ],
    },
  };

  const parsed = parseAntigravityQuota(payload);
  assert.ok(parsed);
  assert.equal(parsed.displayName, 'Gemini Models');
  assert.equal(parsed.remaining, 64);
  assert.equal(parsed.used, 36);
  assert.equal(parsed.windowMinutes, 300);
  assert.equal(parsed.resetsAt, Date.parse('2026-09-17T15:29:02Z') / 1000);

  assert.ok(parsed.secondary);
  assert.equal(parsed.secondary.remaining, 94);
  assert.equal(parsed.secondary.used, 6);
  assert.equal(parsed.secondary.windowMinutes, 10080);
  assert.equal(parsed.secondary.resetsAt, Date.parse('2026-09-24T10:29:02Z') / 1000);
});

test('parses 3P group when requested', () => {
  const payload = {
    groups: [
      {
        displayName: 'Claude and GPT models',
        buckets: [
          {
            bucketId: '3p-5h',
            remainingFraction: 0.8,
            resetTime: '2026-09-17T16:00:00Z',
          },
          {
            bucketId: '3p-weekly',
            remainingFraction: 0.95,
            resetTime: '2026-09-24T16:00:00Z',
          },
        ],
      },
    ],
  };

  const parsed = parseAntigravityQuota(payload, 'Claude and GPT models');
  assert.ok(parsed);
  assert.equal(parsed.remaining, 80);
  assert.equal(parsed.used, 20);
  assert.equal(parsed.secondary.remaining, 95);
});

test('P11-I: falls back to the weekly bucket as primary when no 5-hour bucket exists', () => {
  // The real RPC response this was diagnosed against: only a
  // `gemini-weekly` bucket, no `5h` window at all. parseAntigravityQuota
  // used to require the 5-hour bucket unconditionally and return null the
  // moment it was missing, discarding real weekly quota data and showing
  // "No readable Gemini usage data" even though the response had usage.
  const payload = {
    response: {
      groups: [
        {
          displayName: 'Gemini Models',
          description: 'Models within this group: Gemini Flash, Gemini Pro',
          buckets: [
            {
              bucketId: 'gemini-weekly',
              displayName: 'Weekly Limit Remaining',
              window: 'weekly',
              remainingFraction: 0.29,
              resetTime: '2026-09-24T10:29:02Z',
            },
          ],
        },
      ],
    },
  };

  const parsed = parseAntigravityQuota(payload);
  assert.ok(parsed, 'a weekly-only response should still produce usable quota data');
  assert.equal(parsed.remaining, 29);
  assert.equal(parsed.used, 71);
  assert.equal(parsed.windowMinutes, 10080);
  assert.equal(parsed.resetsAt, Date.parse('2026-09-24T10:29:02Z') / 1000);
  // There is only the one bucket -- secondary must not fabricate a second
  // window out of the same data.
  assert.equal(parsed.secondary, null);
});

test('returns null for missing or invalid Antigravity payload', () => {
  assert.equal(parseAntigravityQuota(null), null);
  assert.equal(parseAntigravityQuota({}), null);
  assert.equal(parseAntigravityQuota({ response: { groups: [] } }), null);
  assert.equal(
    parseAntigravityQuota({
      response: {
        groups: [{ displayName: 'Gemini Models', buckets: [] }],
      },
    }),
    null,
  );
});
