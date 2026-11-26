// Gemini's cards: its own one-line summary as the row, the command inside, a ManageTask card that names its task, and the result.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { openChat } from './ui-tester/boot.mjs';

const send = (page, data) => page.evaluate((message) => window.dispatchEvent(new MessageEvent('message', { data: message })), data);
const browser = await chromium.launch({ headless: true });
try {
  const { page, problems } = await openChat(browser, { width: 560, height: 700 });
  await send(page, { type: 'userMessage', text: 'Check the fingerprint tool' });
  await send(page, { type: 'tool_start', toolId: 'step-3', name: 'bash', command: 'sha256sum "$BASE/outputs/libfprint-2.so" && grep -n -E "enable|disable" /usr/sbin/pam-auth-update | head -n 25', summary: 'Hash release artifacts and check pam-auth-update flags', agent: 'gemini' });
  await send(page, { type: 'tool_end', toolId: 'step-3', output: 'Command exited with code 0.\n\nabc123  libfprint-2.so', agent: 'gemini' });
  await send(page, { type: 'tool_start', toolId: 'step-4', name: 'manage_task', command: 'kill Run the enroll tool (task-262)', agent: 'gemini' });
  await send(page, { type: 'tool_end', toolId: 'step-4', output: 'Task "x/task-262" cancelled.', agent: 'gemini' });
  await send(page, { type: 'tool_start', toolId: 'step-5', name: 'bash', command: 'ls -la', agent: 'gemini' });
  await send(page, { type: 'tool_end', toolId: 'step-5', output: 'total 0', agent: 'gemini' });
  // Newer agy names its file tool write_file; chats saved before that was known must open the file too.
  await send(page, { type: 'tool_start', toolId: 'step-6', name: 'write_file', command: 'dual-reader/pam_pressmatch_dual.c', file: 'dual-reader/pam_pressmatch_dual.c', diff: '+int main(void) {}', agent: 'gemini' });
  await send(page, { type: 'tool_end', toolId: 'step-6', output: '', agent: 'gemini' });
  await page.waitForTimeout(400);
  const written = page.locator('.tool-card').nth(3);
  assert.ok(await written.evaluate((el) => el.classList.contains('tool-edit')), 'Write File is an edit card, not the clock');
  assert.equal(await written.getAttribute('data-peek'), 'file', 'and it opens its file');
  assert.equal(await written.locator('.tool-peek').count(), 1);
  const cards = page.locator('.tool-card');
  assert.equal(await cards.count(), 4);
  assert.equal(await cards.nth(0).locator('.tool-label').textContent(), 'Hash release artifacts and check pam-auth-update flags', 'the row says what the step is for');
  await cards.nth(0).locator('summary').click();
  await page.waitForTimeout(300);
  assert.match(await cards.nth(0).textContent(), /\$\s*sha256sum /, 'the command is shown inside the card');
  assert.equal(await cards.nth(0).locator('.agents-tool-command').count(), 0, 'and is not said twice');
  assert.match(await cards.nth(0).locator('.tool-label').getAttribute('title'), /sha256sum/, 'and on hover');
  assert.equal(await cards.nth(1).locator('.tool-label').textContent(), 'kill Run the enroll tool (task-262)');
  assert.equal(await cards.nth(2).locator('.tool-label').textContent(), 'ls -la', 'no summary: the command stays the row');
  assert.equal(await cards.nth(2).locator('.agents-tool-command').count(), 0);
  await cards.nth(1).locator('summary').click();
  await page.waitForTimeout(300);
  assert.match(await cards.nth(0).locator('.tool-body').textContent(), /abc123/);
  assert.match(await cards.nth(1).locator('.tool-body').textContent(), /cancelled/);
  fs.mkdirSync(process.argv[2] || 'out/ui-review', { recursive: true });
  await page.screenshot({ path: `${process.argv[2] || 'out/ui-review'}/gemini-tool-cards.png` });
  assert.deepEqual(problems, []);
  console.log('gemini-tool-cards ok');
} finally { await browser.close(); }
