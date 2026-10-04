'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { report, benchmark } = require('../lib/routing-benchmark');

test('smoke report exposes escaped fallback reasons for unexercised tiers', () => {
  const html = report([{ prompt: 'Fix heading', pick: 'fast', confidence: 1, tier: 'deterministic', latency_ms: 2,
    action: 'continue', reason: 'session compatible', attempts: [
      { tier: 'cloudflare', status: 'fallback', reason: 'connection missing' },
      { tier: 'groq', status: 'fallback', reason: '<script>untrusted</script>' },
    ] }], [{ id: 'fast' }]);
  assert.ok(html.includes('<small>cloudflare: connection missing</small>'));
  assert.ok(html.includes('<small>groq: &lt;script&gt;untrusted&lt;/script&gt;</small>'));
  assert.ok(!html.includes('<script>untrusted</script>'));
});

test('benchmarks above ten remain locked before reading history or calling a router', async () => {
  let called = false;
  await assert.rejects(benchmark({ n: 50, router: { route() { called = true; } } }), /locked until you confirm/);
  assert.equal(called, false);
});
