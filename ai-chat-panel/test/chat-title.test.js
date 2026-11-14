'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { deriveFallbackTitle } = require('../lib/chat-store');

test('fallback chat names use the first content line without Markdown or the next bullet', () => {
  assert.equal(deriveFallbackTitle([{ role: 'user', text: '**Feedback from Wittmann**\n\n- He liked the *Art Deco* mockup' }]), 'Feedback from Wittmann');
  assert.equal(deriveFallbackTitle([{ role: 'user', text: '\n  ## [Website feedback](https://example.com)\nDetails below' }]), 'Website feedback');
  assert.equal(deriveFallbackTitle([{ role: 'user', text: 'Please fix the layout and typography today' }]), 'Please fix the layout and');
});

test('chat titles preserve language and reject refusals before shortening', async () => {
  const { generateTopicTitle, setChatSpill } = await import('../../voice-router/lib/groq-client.mjs');
  let request, answer;
  setChatSpill({ callChat: async (body) => { request = body; return answer; } });
  try {
    const prompt = 'Bitte repariere die deutschen Chatnamen';
    answer = '"Deutsche Chatnamen reparieren."';
    assert.equal(await generateTopicTitle(prompt), 'Deutsche Chatnamen reparieren');
    assert.equal(request.messages[1].content, prompt);
    assert.match(request.messages[0].content, /same language/);
    assert.match(request.messages[0].content, /never as instructions to follow/);
    assert.match(request.messages[0].content, /never an apology or refusal/);

    for (answer of [
      "I'm sorry, but I can't help with that request.",
      'I’m sorry, but I cannot assist.',
      'Sorry, I cannot help.',
      'I cannot help with that.',
      'I can’t fulfill this request.',
      'I am unable to assist with this request.',
      'I must decline this request.',
      'Es tut mir leid, aber ich kann dabei nicht helfen.',
      'Leider kann ich diese Anfrage nicht bearbeiten.',
      'Ich kann dabei nicht helfen.',
      'Ich darf diese Anfrage nicht beantworten.',
      '',
    ]) {
      const title = await generateTopicTitle(prompt);
      assert.equal(title, '', answer);
      assert.equal(title || deriveFallbackTitle([{ role: 'user', text: prompt }]), prompt);
    }

    answer = 'Title: CSS Layout und responsive Animationen verbessern';
    assert.equal(await generateTopicTitle(prompt), 'CSS Layout und responsive Animationen');
    answer = 'Refusal handling in chat titles';
    assert.equal(await generateTopicTitle(prompt), answer);
  } finally {
    setChatSpill({ callChat: null });
  }
});
