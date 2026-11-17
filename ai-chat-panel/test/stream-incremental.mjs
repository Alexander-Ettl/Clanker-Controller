// A streamed reply is rendered incrementally (finished blocks stay in the DOM). It has to end up exactly like the same
// text rendered in one go, whatever the chunking. Real page against the fake host, no model calls.
//   node ai-chat-panel/test/stream-incremental.mjs
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { openChat } from './ui-tester/boot.mjs';

const CORPORA = {
  prose: 'First paragraph with **bold** and `code`.\n\nSecond paragraph\nwith a line break.\n\n# Heading\n\nThird paragraph.\n\n---\n\nLast one.',
  lists: 'Intro line.\n\n1. one\n\n2. two\n\n   nested text\n\n3. three\n\nAfter the list.\n\n- a\n- b\n\n- c after a blank\n\nDone.',
  fences: 'Before.\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nBetween.\n\n```\nplain\n```\nAfter fence directly.\n\n```py\nunclosed(',
  table: 'Table:\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nAnd a quote:\n\n> quoted\n> more\n\n> second quote\n\nEnd.',
  math: 'Maths:\n\n$$\nx = 1\n\ny = 2\n$$\n\nThen text with $a+b$ inline.\n\nFinal.',
  mixed: 'Intro.\n\n- item one\n- item two\n\nParagraph right after.\n\n1. first\n2. second\n\n```sh\nnpm test\n```\n\n- [x] done task\n- [ ] open task\n\nClosing words with a [link](https://example.com) and src/main.js:12.',
  footnote: 'Has a note[^1].\n\nMore text.\n\n[^1]: The note.',
};

const rng = (seed) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const strip = (html) => html.replace(/<\/?span[^>]*>/g, '').replace(/fn-[a-z0-9]+-/g, 'fn-X-'); // footnote ids carry a random prefix

const browser = await chromium.launch();
try {
  const { page, problems } = await openChat(browser, { width: 900, height: 900 });
  await page.clock.resume();
  const send = (data) => page.evaluate((message) => window.dispatchEvent(new MessageEvent('message', { data: message })), data);
  const frame = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const bodies = () => page.evaluate(() => [...document.querySelectorAll('.msg-assistant .msg-body')].map((el) => el.innerHTML));

  let checked = 0;
  for (const [name, text] of Object.entries(CORPORA)) {
    await send({ type: 'chatLoaded', chat: { id: `full-${name}`, messages: [{ role: 'user', text: 'q' }, { role: 'assistant', agent: 'codex', text }] }, running: null });
    await frame();
    const expected = strip((await bodies()).join('|'));
    assert.ok(expected.length > 10, `${name}: the full render is not empty`);

    for (let seed = 1; seed <= 6; seed++) {
      const next = rng(seed * 7919 + name.length);
      await send({ type: 'chatLoaded', chat: { id: `stream-${name}-${seed}`, messages: [{ role: 'user', text: 'q' }] }, running: { agentId: 'codex', modelLabel: 'GPT', startedAt: 1 } });
      await frame();
      for (let i = 0; i < text.length;) {
        const size = 1 + Math.floor(next() * (seed % 2 ? 4 : 40));
        await send({ type: 'delta', model: 'codex', text: text.slice(i, i + size) });
        i += size;
        if (next() < 0.4) await frame(); // some deltas share a frame, some do not
      }
      await frame();
      await send({ type: 'turn_complete', agent: 'codex' });
      await frame();
      assert.equal(strip((await bodies()).join('|')), expected, `${name} (seed ${seed}): streamed render matches the full render`);
      checked++;
    }
  }
  assert.deepEqual(problems, [], 'no page errors');
  console.log(`Incremental streaming: ${checked} streamed replies match their full render.`);
} finally { await browser.close(); }
