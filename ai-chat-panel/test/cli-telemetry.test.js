'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { configureCliTelemetry, cliTelemetry } = require('../lib/cli-telemetry.js');

test('telemetry is blocked per CLI unless the switch is on; agy only loses its feedback survey', () => {
  configureCliTelemetry(() => false);
  assert.ok(cliTelemetry('codex').args.includes('analytics.enabled=false'));
  assert.equal(cliTelemetry('claude').env.DISABLE_TELEMETRY, '1');
  assert.deepEqual(cliTelemetry('gemini'), { args: ['--settings', '{"showFeedbackSurvey":false}'], env: {} });
  assert.deepEqual(cliTelemetry('copilot'), { args: [], env: {} });
  configureCliTelemetry(() => true);
  for (const agent of ['codex', 'claude', 'gemini']) assert.deepEqual(cliTelemetry(agent), { args: [], env: {} });
});
