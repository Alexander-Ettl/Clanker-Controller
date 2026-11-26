// Thoughts stay open across tool calls so you can read what the model is thinking while tools run.
// When the next thought arrives, the previous thought collapses and the tools between them bundle into "N steps".
// When reply text arrives or the turn ends, all thoughts and their tool bundles collapse together above the answer.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { openChat } from './ui-tester/boot.mjs';

const send = (page, data) => page.evaluate((message) => window.dispatchEvent(new MessageEvent('message', { data: message })), data);
const out = process.argv[2] || 'out/ui-review';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const LONG = 'The register values REG_FINGER and REG_MCU_STATUS before initialization are unexpectedly returning non-zero values, indicating an issue with the initial state or reset. This contradicts the expected behavior in omgrant-ft9201.c, where REG_FINGER should be zero.\n\nThe bench test seems to hang or crash after printing "Reopened! new bg_sd=8.9" but before printing the "Verify tap" message. The code flow suggests a hang in wait_and_capture or a crash within elanpress_pose_graph_match_pose.';
try {
  for (const theme of ['dark', 'light']) {
    const { page, problems } = await openChat(browser, { width: 560, height: 760 });
    if (theme === 'light') await page.evaluate(() => { document.body.classList.remove('vscode-dark'); document.body.classList.add('vscode-light'); });
    await page.clock.resume();
    await send(page, { type: 'userMessage', text: 'Why does the bench hang?' });
    await send(page, { type: 'routing', agentId: 'gemini', modelLabel: 'Gemini' });
    const cards = page.locator('.thought-fold');

    // 1. A thought is open from its first word, renders Markdown, shows the digital brain icon with no "Thinking" flash,
    //    and has no top-edge mask fading the first line when un-scrolled.
    await send(page, { type: 'thought', text: '**First** I will inspect `REG_FINGER` and `omgrant-ft9201.c`. ', agent: 'gemini' });
    await page.waitForTimeout(150);
    assert.equal(await cards.count(), 1);
    assert.equal(await cards.first().evaluate((el) => el.open), true, 'open at the start');
    assert.equal(await cards.first().locator('.thought-label').isVisible(), false, 'no "Thinking" flash while live');
    assert.equal(await cards.first().locator('.thought-icon circle').count(), 4, 'digital circuit brain icon rendered');
    assert.equal(await cards.first().locator('.thought-body strong').textContent(), 'First', 'Markdown bold renders inside thought');
    assert.ok(await cards.first().locator('.thought-body code').count() >= 1, 'Markdown inline code renders inside thought');
    assert.equal(await cards.first().locator('.thought-body').evaluate((el) => getComputedStyle(el).maskImage), 'none', 'first line is never masked when un-scrolled');
    assert.equal(await page.locator('.msg-pending').count(), 0, 'the pill steps aside while the card is the status');
    await send(page, { type: 'thought', text: LONG, agent: 'gemini' });
    await page.waitForTimeout(150);
    assert.match(await cards.first().locator('.thought-body').textContent(), /Verify tap/);
    if (theme === 'dark') await page.screenshot({ path: `${out}/thought-live-${theme}.png` });

    // 2. Tool usage settles the live shimmer but keeps the thought open so you can still read it.
    await send(page, { type: 'tool_start', toolId: 's1', name: 'bash', command: 'ls', agent: 'gemini' });
    await send(page, { type: 'tool_end', toolId: 's1', output: 'x', agent: 'gemini' });
    await send(page, { type: 'tool_start', toolId: 's2', name: 'read_file', command: 'omgrant-ft9201.c', agent: 'gemini' });
    await send(page, { type: 'tool_end', toolId: 's2', output: 'int reg = 0;', agent: 'gemini' });
    await page.waitForTimeout(250);
    assert.equal(await cards.first().evaluate((el) => el.open), true, 'tool usage does not close the open thought');
    assert.equal(await cards.first().evaluate((el) => el.classList.contains('is-live')), false);
    assert.equal(await cards.first().locator('.thought-label').isVisible(), false, 'settled Thought process label is hidden');

    // 3. A second thought auto-collapses the first and bundles the tools between them into "2 steps".
    await send(page, { type: 'thought', text: 'Now checking the capture loop timeout.', agent: 'gemini' });
    await page.waitForTimeout(550);
    assert.equal(await cards.count(), 2);
    assert.deepEqual(await cards.evaluateAll((els) => els.map((el) => el.open)), [false, true], 'previous thought collapsed, newest stays open');
    assert.match(await cards.first().locator('.thought-preview').textContent(), /^First I will inspect REG_FINGER/);
    const midBundles = page.locator('.work-summary.is-thought-steps');
    assert.equal(await midBundles.count(), 1, 'tools between thoughts bundle into one collapsed summary');
    assert.equal(await midBundles.first().locator('.work-label').textContent(), '2 steps');
    assert.equal(await midBundles.first().evaluate((el) => el.open), false);

    // Clicking the bundled "2 steps" expands the hidden tools again.
    await midBundles.first().locator('> summary').click();
    assert.equal(await midBundles.first().evaluate((el) => el.open), true);
    assert.equal(await midBundles.first().locator('.tool-card').count(), 2);
    await midBundles.first().locator('> summary').click();
    assert.equal(await midBundles.first().evaluate((el) => el.open), false);

    // 4. Update Steps sits in the same bucket as thoughts: opens uncollapsed with non-code checklist UI,
    // closes the previous thought, bundles prior tools, stays open across its own tools, and auto-collapses when the next thought arrives.
    for (const i of [1, 2, 3]) {
      await send(page, { type: 'tool_start', toolId: `b${i}`, name: 'bash', command: `echo ${i}`, agent: 'gemini' });
      await send(page, { type: 'tool_end', toolId: `b${i}`, output: String(i), agent: 'gemini' });
    }
    await send(page, { type: 'tool_start', toolId: 'plan1', name: 'update_steps', command: 'Refine nested thought-step styles (2/4)', agent: 'gemini' });
    await send(page, { type: 'tool_end', toolId: 'plan1', output: '✓ Update thought and tool bundling logic\n▸ Refine nested thought-step styles\n○ Update and add UI verification tests\n○ Verify tests and inspect screenshots', agent: 'gemini' });
    await send(page, { type: 'tool_start', toolId: 'p1', name: 'edit_file', command: 'ai-chat-panel/media/style.css', agent: 'gemini' });
    await send(page, { type: 'tool_end', toolId: 'p1', output: 'updated', agent: 'gemini' });
    await page.waitForTimeout(550);
    const todoCard = page.locator('.tool-card.tool-todo').first();
    assert.equal(await todoCard.evaluate((el) => el.open), true, 'Update Steps stays uncollapsed across tool calls');
    assert.deepEqual(await cards.evaluateAll((els) => els.map((el) => el.open)), [false, false], 'Update Steps collapsed the prior thought');
    assert.equal(await todoCard.locator('.todo-step').count(), 4);
    assert.equal(await todoCard.locator('.todo-step.is-done').count(), 1);
    assert.equal(await todoCard.locator('.todo-step.is-active').count(), 1);
    assert.equal(await todoCard.locator('.todo-step.is-pending').count(), 2);
    const bodyFont = await todoCard.locator('.todo-steps').evaluate((el) => getComputedStyle(el).fontFamily);
    const monoFont = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim());
    assert.notEqual(bodyFont, monoFont, 'Update Steps uses proportional UI font, not monospace code font');
    assert.equal(await todoCard.locator('.tool-name').isVisible(), false, 'Update Steps prefix label is hidden when step text is present');
    await page.screenshot({ path: `${out}/thought-update-steps-${theme}.png` });

    // A third thought auto-collapses Update Steps and bundles the tool step after it.
    await send(page, { type: 'thought', text: 'Applying the reset fix and verifying.', agent: 'gemini' });
    await send(page, { type: 'tool_start', toolId: 'c1', name: 'bash', command: 'make test', agent: 'gemini' });
    await send(page, { type: 'tool_end', toolId: 'c1', output: 'ok', agent: 'gemini' });
    await page.waitForTimeout(550);
    assert.equal(await todoCard.evaluate((el) => el.open), false, 'a new thought collapses Update Steps');
    assert.deepEqual(await cards.evaluateAll((els) => els.map((el) => el.open)), [false, false, true], 'only the latest thought stays open across tools');
    assert.deepEqual(await page.locator('.work-summary.is-thought-steps > summary .work-label').allTextContents(), ['2 steps', '3 steps', '1 step']);
    await page.screenshot({ path: `${out}/thought-midturn-${theme}.png` });

    // 5. Final reply text closes all thoughts and bundles all thoughts, Update Steps, and tool groups into ONE collapsed summary above the answer.
    await send(page, { type: 'delta', text: 'The hang happens because REG_FINGER is read before reset completes.', model: 'gemini', agent: 'gemini' });
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.thought-fold[open], .tool-todo[open]').count(), 0, 'all thoughts and checklists collapse when the final answer arrives');
    const outerSummaries = page.locator('.turn > .work-summary:not(.is-empty)');
    assert.equal(await outerSummaries.count(), 1, 'all thoughts, checklists and tool bundles collapse into one outer summary');
    assert.equal(await outerSummaries.first().evaluate((el) => el.open), false);
    assert.equal(await outerSummaries.first().locator('> summary .work-label').textContent(), '11 steps', '3 thoughts + 1 update_steps + 2 + 3 + 1 + 1 tools = 11 steps');

    // Expanding the outer summary shows the tidy "Thought process / Update Steps -> N steps" cadence inside.
    await outerSummaries.first().locator('> summary').click();
    assert.equal(await outerSummaries.first().locator('> .work-steps > .thought-fold').count(), 3);
    assert.equal(await outerSummaries.first().locator('> .work-steps > .tool-todo').count(), 1);
    assert.deepEqual(await outerSummaries.first().locator('> .work-steps > .work-summary.is-thought-steps > summary .work-label').allTextContents(), ['2 steps', '3 steps', '1 step', '1 step']);
    const first = outerSummaries.first().locator('.thought-fold').first();
    await first.locator('summary').click();
    await page.waitForTimeout(250);
    assert.equal(await first.evaluate((el) => el.open), true);
    assert.match(await first.locator('.thought-body').textContent(), /inspect REG_FINGER/);
    await page.screenshot({ path: `${out}/thought-after-${theme}.png` });

    // 6. The end of the turn closes a thought that was still open; an empty thought leaves nothing behind and does not close an open thought.
    await send(page, { type: 'thought', text: 'Still thinking when it ends.', agent: 'gemini' });
    await send(page, { type: 'thought', text: '   ', agent: 'gemini' });
    assert.equal(await page.locator('.thought-fold.is-live').count(), 1);
    await send(page, { type: 'turn_complete', agent: 'gemini' });
    await page.waitForTimeout(400);
    assert.equal(await page.locator('.thought-fold.is-live').count(), 0);
    assert.equal(await page.locator('.thought-fold[open]').evaluateAll((els) => els.filter((el) => el.querySelector('.thought-body').textContent.includes('Still thinking')).length), 0);
    assert.deepEqual(problems, []);
    await page.context().close();
  }
  console.log('thought-cards ok');
} finally { await browser.close(); }
