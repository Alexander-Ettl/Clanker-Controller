// Real-page regression: sending a prompt must move the page a little each frame, never all at once.
//
// The clock is paused and stepped at exactly 60 fps, every Web Animation the send starts is paused and seeked to the frame time, and
// each frame is a real screenshot of the painted page (a ResizeObserver only runs when a frame is produced, and the transcript's
// tail pin is one). Before this was fixed a send moved the conversation 130px in one frame (a prompt sent to an idle chat), 94px
// (the first queued prompt: the strip appeared at full height at once) or 48px (the next one), and the box that held the sent text
// dropped 19px in a frame. Run `node ai-chat-panel/test/send-motion.mjs --save=<dir>` to keep every frame as a PNG for a look.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { openChat } from './ui-tester/boot.mjs';

const FRAME = 1000 / 60, FRAMES = 40, MAX_STEP = 24; // px per frame: the eased moves peak near 15
const save = process.argv.find(arg => arg.startsWith('--save='))?.slice(7);

const messages = [];
for (let i = 0; i < 6; i++) {
  messages.push({ role: 'user', text: `Question number ${i + 1}: please look at the sync worker and tell me what you think.` });
  messages.push({ role: 'assistant', agent: 'claude', text: `Answer ${i + 1}. `.repeat(3) + 'A longer paragraph so the transcript has real height and the scroll pin matters.\n\n- one\n- two\n- three' });
}

async function record(browser, { running, queued, draft, name }) {
  const { page } = await openChat(browser, { width: 760, height: 760 });
  await page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), {
    type: 'chatLoaded', running: running ? { agentId: 'claude', startedAt: Date.now() } : undefined,
    chat: { id: 'send-motion', messages, ...(queued ? { turnQueue: { turns: queued, paused: false } } : {}) },
  });
  await page.clock.runFor(1500); await page.waitForTimeout(400);
  await page.locator('#promptInput').fill(draft);
  await page.clock.runFor(800); await page.waitForTimeout(300);
  await page.evaluate(() => { const users = [...document.querySelectorAll('.msg-user')]; window.anchor = users[users.length - 1]; });
  await page.clock.pauseAt(new Date(2026, 2, 2, 9, 0, 0));
  const sample = t => page.evaluate(t => {
    window.anims?.forEach(animation => { try { animation.currentTime = t; } catch { /* finished and removed */ } });
    const $ = selector => document.querySelector(selector);
    return { t, anchor: window.anchor.getBoundingClientRect().top, dock: $('.compose-row').getBoundingClientRect().top, composer: $('.composer').getBoundingClientRect().top,
      scrollTop: $('.transcript').scrollTop };
  }, t);
  const frames = [await sample(-FRAME)];
  await page.evaluate(() => {
    document.querySelector('#promptInput').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    window.anims = document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity);
    window.anims.forEach(animation => { animation.pause(); animation.currentTime = 0; });
  });
  if (save) fs.mkdirSync(`${save}/${name}`, { recursive: true });
  for (let i = 0; i <= FRAMES; i++) {
    if (i > 0) await page.clock.runFor(FRAME);
    frames.push(await sample(i * FRAME));
    const shot = await page.screenshot({ path: save ? `${save}/${name}/f${String(i).padStart(3, '0')}.png` : undefined });
    assert.ok(shot.length > 0);
  }
  await page.close();
  return frames;
}

const steps = (frames, key) => frames.slice(1).map((frame, i) => frame[key] - frames[i][key]);
const moving = list => list.filter(step => Math.abs(step) >= 0.5).length;
const biggest = list => Math.max(...list.map(Math.abs));

const browser = await chromium.launch({ headless: true });
try {
  // A prompt sent to an idle chat: the new message arrives below the fold and the conversation glides up to it.
  const idle = await record(browser, { name: 'idle', draft: 'Move the jitter before the cap and add a regression test.' });
  const scroll = steps(idle, 'scrollTop');
  assert.ok(biggest(scroll) <= MAX_STEP, `the tail scrolled ${biggest(scroll)}px in one frame (idle send)`);
  assert.ok(moving(scroll) >= 10, `the tail glide took ${moving(scroll)} frames, expected a visible glide of at least 10`);
  assert.ok(scroll.every(step => step >= 0), 'the glide never scrolls backwards');

  // The first prompt queued behind a running turn: the strip grows out of the composer, the dock's top edge and the
  // conversation above it follow frame by frame, and the box that held the typed text settles down.
  const queued = await record(browser, { name: 'queue', running: true, draft: 'Also update the changelog entry afterwards.\nKeep it short.' });
  for (const [key, label] of [['anchor', 'conversation'], ['dock', 'dock top edge'], ['composer', 'composer top']]) {
    const list = steps(queued, key);
    assert.ok(biggest(list) <= MAX_STEP, `${label} moved ${biggest(list)}px in one frame (first queued prompt)`);
  }
  assert.ok(moving(steps(queued, 'dock')) >= 8, 'the dock grows over several frames');
  assert.ok(moving(steps(queued, 'anchor')) >= 8, 'the conversation follows the dock over several frames');
  const anchorSteps = steps(queued, 'anchor').filter(step => Math.abs(step) >= 0.5);
  assert.ok(anchorSteps.every(step => step < 0), 'the conversation moves one way only, with no bounce');

  // A second prompt joins a queue that is already showing: one more row, one more smooth step.
  const second = await record(browser, { name: 'second', running: true, draft: 'And then run the tests again.\nPlease.',
    queued: [{ id: 'q0', text: 'First queued prompt that is already waiting.', modelId: 'claude-opus-5-5-high', attachments: [] }] });
  for (const [key, label] of [['anchor', 'conversation'], ['dock', 'dock top edge']]) {
    assert.ok(biggest(steps(second, key)) <= MAX_STEP, `${label} moved ${biggest(steps(second, key))}px in one frame (second queued prompt)`);
  }
  assert.ok(moving(steps(second, 'dock')) >= 6, 'the second row grows the dock over several frames');
  console.log('send-motion ok: idle send, first queued prompt and second queued prompt all move frame by frame');
} finally { await browser.close(); }
