'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { subscriptionBilled } = require('../lib/billing-mode');

const home = path.join('C:', 'Users', 'me');
const files = (map) => (file) => map[path.relative(home, file).split(path.sep).join('/')] ?? null;
const opts = (map, env = {}) => ({ env, home, readFile: files(map) });

test('Claude counts as a subscription only when it is signed in with an account and no API key is configured', () => {
  const signedIn = { '.claude/.credentials.json': { claudeAiOauth: { accessToken: 'x' } } };
  assert.equal(subscriptionBilled('claude', opts(signedIn)), true);
  assert.equal(subscriptionBilled('claude', opts({ '.claude/.claude.json': { oauthAccount: {} } })), true);
  assert.equal(subscriptionBilled('claude', opts({})), false, 'no sign-in seen: not assumed');
  assert.equal(subscriptionBilled('claude', opts(signedIn, { ANTHROPIC_API_KEY: 'sk-x' })), false);
  assert.equal(subscriptionBilled('claude', opts(signedIn, { CLAUDE_CODE_USE_BEDROCK: '1' })), false);
  assert.equal(subscriptionBilled('claude', opts(signedIn, { CLAUDE_CODE_USE_BEDROCK: '0' })), true);
  assert.equal(subscriptionBilled('claude', opts({ ...signedIn, '.claude/settings.json': { apiKeyHelper: 'get-key' } })), false);
  assert.equal(subscriptionBilled('claude', opts({ ...signedIn, '.claude/settings.json': { env: { ANTHROPIC_API_KEY: 'sk-x' } } })), false);
});

test('Codex counts as a subscription only in ChatGPT sign-in mode without an API key', () => {
  assert.equal(subscriptionBilled('codex', opts({ '.codex/auth.json': { auth_mode: 'chatgpt', OPENAI_API_KEY: null } })), true);
  assert.equal(subscriptionBilled('codex', opts({ '.codex/auth.json': { auth_mode: 'apikey', OPENAI_API_KEY: 'sk-x' } })), false);
  assert.equal(subscriptionBilled('codex', opts({ '.codex/auth.json': { auth_mode: 'chatgpt' } }, { OPENAI_API_KEY: 'sk-x' })), false);
  assert.equal(subscriptionBilled('codex', opts({})), false);
});

test('Antigravity counts as a subscription unless a Google API key or Vertex is configured', () => {
  assert.equal(subscriptionBilled('gemini', opts({})), true);
  assert.equal(subscriptionBilled('gemini', opts({}, { GEMINI_API_KEY: 'k' })), false);
  assert.equal(subscriptionBilled('gemini', opts({}, { GOOGLE_GENAI_USE_VERTEXAI: 'true' })), false);
});
