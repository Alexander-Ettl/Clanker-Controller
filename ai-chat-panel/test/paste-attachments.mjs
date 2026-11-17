// Real composer with a deliberately delayed host acknowledgement; no model calls.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { openChat } from './ui-tester/boot.mjs';
const browser = await chromium.launch();
try {
  const { page, problems } = await openChat(browser, { width: 900, height: 900 });
  await page.clock.resume();
  const post = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
  await post({ type: 'chatLoaded', chat: { id: 'paste-test', messages: [] } });
  const paste = () => page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 250;
    canvas.getContext('2d').fillRect(0, 0, 400, 250);
    const blob = await new Promise(resolve => canvas.toBlob(resolve));
    const transfer = new DataTransfer(); transfer.items.add(new File([blob], 'paste.png', { type: 'image/png' }));
    document.querySelector('textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true }));
    return !!document.querySelector('.attachment-chip.is-attaching img[src^="blob:"]');
  });
  await page.locator('textarea').first().fill('Inspect this image');
  assert.equal(await paste(), true, 'preview is inserted synchronously in the paste handler');
  await page.locator('textarea').first().press('Enter');
  await page.waitForFunction(() => window.sent.some(m => m.type === 'attachmentData'));
  const request = await page.evaluate(() => window.sent.findLast(m => m.type === 'attachmentData'));
  assert.equal(await page.evaluate(() => window.sent.filter(m => m.type === 'send' || m.type === 'queueTurn').length), 0, 'Enter must wait for the host save');
  await post({ type: 'attachmentSaved', chatId: 'paste-test', requestId: request.requestId, attachment: { path: 'saved.png', name: 'paste.png', mime: 'image/png', uri: request.data } });
  await page.waitForFunction(() => window.sent.some(m => m.type === 'send'));
  const sends = await page.evaluate(() => window.sent.filter(m => m.type === 'send'));
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0].attachments, ['saved.png']);
  await post({ type: 'chatLoaded', chat: { id: 'paste-failure', messages: [] } });
  await page.locator('textarea').first().fill('Keep this draft');
  assert.equal(await paste(), true);
  await page.locator('textarea').first().press('Enter');
  await page.waitForFunction(() => window.sent.filter(m => m.type === 'attachmentData').length === 2);
  const failed = await page.evaluate(() => window.sent.findLast(m => m.type === 'attachmentData'));
  await post({ type: 'attachmentFailed', requestId: failed.requestId, error: 'Disk unavailable' });
  await page.waitForTimeout(50);
  assert.equal(await page.locator('textarea').first().inputValue(), 'Keep this draft');
  assert.equal(await page.evaluate(() => window.sent.filter(m => m.type === 'send').length), 1, 'failed save never sends the draft');
  await post({ type: 'chatLoaded', chat: { id: 'paste-batch', messages: [] } });
  await page.locator('textarea').first().fill('Two images');
  await paste(); await paste();
  await page.locator('textarea').first().press('Enter');
  await page.waitForFunction(() => window.sent.filter(m => m.type === 'attachmentData').length === 4);
  const batch = await page.evaluate(() => window.sent.filter(m => m.type === 'attachmentData').slice(-2));
  for (const [index, name] of [[1, 'second.png'], [0, 'first.png']]) {
    await post({ type: 'attachmentSaved', chatId: 'paste-batch', requestId: batch[index].requestId, attachment: { path: name, name, mime: 'image/png', uri: batch[index].data } });
    if (index === 1) assert.equal(await page.evaluate(() => window.sent.filter(m => m.type === 'send').length), 1);
  }
  await page.waitForFunction(() => window.sent.filter(m => m.type === 'send').length === 2);
  assert.deepEqual(await page.evaluate(() => window.sent.filter(m => m.type === 'send').at(-1).attachments), ['first.png', 'second.png']);
  await post({ type: 'chatLoaded', chat: { id: 'paste-navigation', messages: [] } });
  await page.locator('textarea').first().fill('Keep in original chat');
  await paste();
  await page.locator('textarea').first().press('Enter');
  await page.waitForFunction(() => window.sent.filter(m => m.type === 'attachmentData').length === 5);
  const navigation = await page.evaluate(() => window.sent.findLast(m => m.type === 'attachmentData'));
  await post({ type: 'chatLoaded', chat: { id: 'different-chat', messages: [] } });
  assert.equal(await page.locator('textarea').first().evaluate(el => el.readOnly), false, 'the new chat is immediately editable');
  await post({ type: 'attachmentSaved', chatId: 'paste-navigation', requestId: navigation.requestId, attachment: { path: 'original.png', name: 'original.png', mime: 'image/png', uri: navigation.data } });
  await page.waitForTimeout(50);
  assert.equal(await page.locator('.attachment-strip .attachment-chip').count(), 0);
  assert.equal(await page.evaluate(() => window.sent.filter(m => m.type === 'send').length), 2, 'navigation cancels the waiting send');
  assert.deepEqual(problems, []);
  console.log('Paste: immediate preview, Enter waits, failure keeps draft, batch order and navigation passed.');
} finally { await browser.close(); }
