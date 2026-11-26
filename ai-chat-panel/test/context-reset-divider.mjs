import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { openChat } from './ui-tester/boot.mjs';

// A CLI that compacts itself, or a fresh session Clanker starts, must leave the same divider a compaction does, with the reason under it;
// the divider must survive a reload of the chat.
const browser = await chromium.launch({ headless: true, channel: process.platform === 'win32' ? 'msedge' : undefined });
try {
  const { page } = await openChat(browser, { width: 420, height: 700 });
  const send = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
  const dividers = () => page.$$eval('.compact-divider', nodes => nodes.map(node => ({ label: node.querySelector('.compact-label').textContent, detail: node.querySelector('small')?.textContent || '', kind: node.dataset.kind, compacting: node.classList.contains('is-compacting') })));

  await send({ type: 'chatLoaded', chat: { id: 'live', messages: [] } });
  await send({ type: 'userMessage', text: 'Keep going' });
  await send({ type: 'routing', agentId: 'claude', modelLabel: 'Sonnet 5.5' });
  await send({ type: 'contextReset', kind: 'native', title: 'Context auto-compacted by Claude', detail: 'Claude ran out of room and summarised its own session; it carries on from that summary. It held 962k tokens.', agent: 'claude' });
  assert.deepEqual(await dividers(), [{ label: 'Context auto-compacted by Claude', detail: 'Claude ran out of room and summarised its own session; it carries on from that summary. It held 962k tokens.', kind: 'native', compacting: false }]);
  await page.screenshot({ path: 'out/ui-review/context-reset-live-420.png' });

  const reply = (text, contextResets) => ({ role: 'assistant', agent: 'claude', text, at: '2026-11-25T12:00:00Z', ...(contextResets ? { contextResets } : {}) });
  await send({ type: 'chatLoaded', chat: { id: 'stored', messages: [
    { role: 'user', text: 'One', at: '2026-11-25T11:00:00Z' }, reply('First answer'),
    { role: 'user', text: 'Two', at: '2026-11-25T11:30:00Z' },
    reply('Second answer', [{ kind: 'session', title: 'New session · context reset', detail: 'This chat had filled 85% of Claude\'s window (850k of 1.0M), which is the "Start a new session at" limit in Settings. A fresh Claude session was briefed from the chat.', at: '2026-11-25T11:30:01Z' }]),
  ] } });
  const stored = await dividers();
  assert.equal(stored.length, 1, 'one divider, only on the turn that lost its context');
  assert.equal(stored[0].kind, 'session');
  assert.match(stored[0].detail, /85% of Claude's window/);
  const order = await page.$$eval('.compact-divider, .msg-user', nodes => nodes.map(node => node.className.includes('compact-divider') ? 'divider' : 'user'));
  assert.deepEqual(order.slice(-2).includes('divider'), true);
  await page.screenshot({ path: 'out/ui-review/context-reset-stored-420.png' });
  console.log('context-reset-divider ok');
} finally { await browser.close(); }
