'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { learnedTerms } = require('../lib/voice-learn.js');
const { pcmLevels, perceptualMicLevel } = require('../lib/voice-capture.js');

test('learnedTerms: a respelled mishearing is learned', () => {
  assert.deepEqual(learnedTerms('open the tech no matrix model', 'open the Tecnomatix model'), ['Tecnomatix']);
});

test('learnedTerms: a casing fix is learned', () => {
  assert.deepEqual(learnedTerms('write the simtalk method', 'write the SimTalk method'), ['SimTalk']);
});

test('learnedTerms: rephrasing and plain additions are not', () => {
  assert.deepEqual(learnedTerms('this looks fine to me', 'this looks great to me'), []);
  assert.deepEqual(learnedTerms('fix the bug', 'fix the bug in the router please'), []);
});

test('learnedTerms: newly typed jargon is learned', () => {
  assert.deepEqual(learnedTerms('check the panel', 'check the chat-panel and useQuotaBridge'), ['chat-panel', 'useQuotaBridge']);
});

test('learnedTerms: no change, no terms', () => {
  assert.deepEqual(learnedTerms('same text here', 'same text here'), []);
  assert.deepEqual(learnedTerms('', 'anything'), []);
});

test('pcmLevels: RMS and peak of 16-bit PCM', () => {
  const buffer = Buffer.alloc(8);
  [16384, -16384, 16384, -16384].forEach((v, i) => buffer.writeInt16LE(v, i * 2));
  assert.deepEqual(pcmLevels(buffer), { rms: 0.5, peak: 0.5 });
  assert.deepEqual(pcmLevels(Buffer.alloc(1)), { rms: 0, peak: 0 });
});

test('perceptualMicLevel: suppresses room noise but keeps ordinary speech visible', () => {
  assert.equal(perceptualMicLevel({ rms: 0.002, peak: 0.01 }), 0);
  const quietSpeech = perceptualMicLevel({ rms: 0.01, peak: 0.04 });
  const normalSpeech = perceptualMicLevel({ rms: 0.03, peak: 0.1 });
  assert.ok(quietSpeech > 0.25 && quietSpeech < 0.45);
  assert.ok(normalSpeech > quietSpeech && normalSpeech < 0.8);
  assert.equal(perceptualMicLevel({ rms: 0.08, peak: 0.4 }), 1);
});

test('perceptualMicLevel: rejects an isolated peak without RMS energy', () => {
  assert.equal(perceptualMicLevel({ rms: 0.002, peak: 1 }), 0);
});

