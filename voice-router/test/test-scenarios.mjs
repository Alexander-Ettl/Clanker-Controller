'use strict';

// Exercises the deterministic half of the pipeline (routeDecision, via
// buildRoutingOutput) against fixed quota + intent inputs, so the four
// scenarios from docs/voice-quota-router-spec.md §7 run without a network
// call or a GROQ_API_KEY. The Groq-calling half (classify/transcribeAudio)
// is exercised for real by `node router.mjs`, not here.

import assert from 'node:assert/strict';

import { buildRoutingOutput } from '../lib/groq-client.mjs';
import { readQuotas } from '../lib/quota-reader.mjs';

const scenarios = [
  {
    name: 'UI task, healthy Claude quota -> Claude',
    input: {
      cleanedPrompt: 'Add a new glassmorphism button to the styleguide.',
      primaryIntent: 'ui_aesthetics',
      confidence: 0.92,
      quotas: { claude5hRemainingPct: 58, claude7dRemainingPct: 82, codex5hRemainingPct: 74, geminiStatus: 'healthy' },
    },
    expect: { targetModel: 'claude', quotaOverrideApplied: false, suggestedDispatch: 'editor_chat' },
  },
  {
    name: 'UI task, depleted Claude quota (8%) -> downgraded to Codex',
    input: {
      cleanedPrompt: 'Fix the hover ring animation timing.',
      primaryIntent: 'ui_aesthetics',
      confidence: 0.88,
      quotas: { claude5hRemainingPct: 8, claude7dRemainingPct: 40, codex5hRemainingPct: 90, geminiStatus: 'healthy' },
    },
    expect: { targetModel: 'codex', quotaOverrideApplied: true, suggestedDispatch: 'editor_chat' },
  },
  {
    name: 'AST/schema task -> Codex',
    input: {
      cleanedPrompt: 'Add a Zod field to the content collection schema.',
      primaryIntent: 'backend_ast',
      confidence: 0.95,
      quotas: { claude5hRemainingPct: 70, claude7dRemainingPct: 80, codex5hRemainingPct: 65, geminiStatus: 'healthy' },
    },
    expect: { targetModel: 'codex', quotaOverrideApplied: false, suggestedDispatch: 'terminal_agent' },
  },
  {
    name: 'Planning/roadmap task -> Gemini',
    input: {
      cleanedPrompt: 'Summarize the content editor roadmap across all seven phases.',
      primaryIntent: 'planning_synthesis',
      confidence: 0.9,
      quotas: { claude5hRemainingPct: 55, claude7dRemainingPct: 60, codex5hRemainingPct: 55, geminiStatus: 'healthy' },
    },
    expect: { targetModel: 'gemini', quotaOverrideApplied: false, suggestedDispatch: 'clipboard_only' },
  },
];

let failures = 0;

for (const scenario of scenarios) {
  try {
    const output = buildRoutingOutput(scenario.input);
    assert.equal(output.decision.targetModel, scenario.expect.targetModel);
    assert.equal(output.decision.quotaOverrideApplied, scenario.expect.quotaOverrideApplied);
    assert.equal(output.decision.primaryIntent, scenario.input.primaryIntent);
    assert.equal(output.suggestedDispatch, scenario.expect.suggestedDispatch);
    assert.ok(output.decision.routingReason.length > 0, 'routingReason must be non-empty');
    console.log(`PASS  ${scenario.name} -> ${output.decision.targetModel}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${scenario.name}`);
    console.error(`      ${error.message}`);
  }
}

// Smoke test: the live quota reader must return well-formed numbers
// synchronously even when no Claude/Codex cache exists on this machine.
try {
  const quotas = readQuotas();
  for (const key of ['claude5hRemainingPct', 'claude7dRemainingPct', 'codex5hRemainingPct']) {
    assert.equal(typeof quotas[key], 'number', `${key} must be a number`);
    assert.ok(quotas[key] >= 0 && quotas[key] <= 100, `${key} must be within 0-100`);
  }
  assert.equal(quotas.geminiStatus, 'healthy');
  console.log('PASS  quota-reader.readQuotas() returns well-formed percentages');
} catch (error) {
  failures += 1;
  console.error('FAIL  quota-reader.readQuotas()');
  console.error(`      ${error.message}`);
}

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${scenarios.length + 1} tests passed.`);
}
