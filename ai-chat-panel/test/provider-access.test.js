'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { accessFailure } = require('../lib/provider-access');

test('plan, credit and sign-in failures are recognised on any provider\'s error line', () => {
  const codex = accessFailure('Earlier work.\nCodex error: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-6.1-sol\' model is not supported when using Codex with a ChatGPT account."}}');
  assert.equal(codex.kind, 'plan');
  assert.equal(codex.detail, "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.");
  assert.equal(accessFailure('Claude error: Your credit balance is too low to access the API.').kind, 'credits');
  assert.equal(accessFailure('Gemini error: Please log in again. Authentication failed.').kind, 'auth');
  assert.equal(accessFailure('Unable to start codex: your subscription has expired').kind, 'plan');
  assert.equal(accessFailure('Gemini error: Account ineligible: unsupported location').kind, 'plan', 'agy: region, age or account type');
  assert.equal(accessFailure('Gemini error: Eligibility check failed: rpc error. Please log out (/logout) and log back in (/login).').kind, 'auth');
  assert.equal(accessFailure('Claude error: This organization has been disabled.').kind, 'plan');
  assert.equal(accessFailure('Some Future error: Your trial ended. Upgrade your plan to continue.').kind, 'plan');
});

test('limits that reset, ordinary errors and prose are not outages', () => {
  assert.equal(accessFailure("Codex error: You've hit your usage limit. Upgrade to Plus or try again at 18:30."), null);
  assert.equal(accessFailure('Claude error: You\'ve hit your session limit'), null);
  assert.equal(accessFailure('Codex error: stream disconnected before completion'), null);
  assert.equal(accessFailure('You are unauthorized to read that file, so I used a different path.'), null, 'only an engine error line counts');
  assert.equal(accessFailure('The plan includes an upgrade path.'), null);
  assert.equal(accessFailure(''), null);
});

test('native Claude authentication failures are caught without a Clanker prefix and Cloudflare is distinct', () => {
  const failure = accessFailure('Earlier work.\n\nFailed to authenticate. API Error: 403 Attention Required! | Cloudflare');
  assert.equal(failure.kind, 'blocked');
  assert.match(failure.reason, /Cloudflare.*403/);
  assert.match(failure.detail, /Failed to authenticate/);
  assert.equal(accessFailure('Failed to authenticate. API Error: 401 Unauthorized').kind, 'auth');
  assert.equal(accessFailure('Claude error: Failed to authenticate. API Error: 403 Attention Required! | Cloudflare').kind, 'blocked');
  assert.equal(accessFailure('The website returned 403 Attention Required! | Cloudflare'), null, 'ordinary source-page errors do not disable the provider');
});
