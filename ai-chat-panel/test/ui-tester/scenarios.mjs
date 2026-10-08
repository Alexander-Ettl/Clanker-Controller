// The screens the interface tester visits. A scenario is { id, height?, focus?, setup?(page) } on the real chat page, or
// { id, html } for a static fixture (used by the tester's own tests). `focus` is the element the picture is cropped to.
// Add a scenario here whenever a bug is found by hand: it then stays checked on every run.
import { createRequire } from 'node:module';
const { DEFAULTS } = createRequire(import.meta.url)('../../lib/routing');
const openSettings = tab => page => page.evaluate(name => window.dispatchEvent(new MessageEvent('message', { data: { type: 'openSettings', tab: name } })), tab);
const loopsState = state => async page => {
  await page.evaluate(name => window.setFakeState(name), state);
  await page.locator('#loopsBtn').click();
  await page.locator('.inv .inv-overview').waitFor();
};
const MODAL = '.fs-modal:not([hidden]) .fs-modal-sheet';

// Two real PDF pages exercise the renderer and navigation without external files or model calls.
function samplePdf() {
  const stream = title => `BT /F1 24 Tf 30 220 Td (${title}) Tj ET\n0.35 0.5 0.85 rg 30 80 140 80 re f`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    ...[5, 6].map(id => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 280] /Resources << /Font << /F1 7 0 R >> >> /Contents ${id} 0 R >>`),
    ...['Preview one', 'Preview two'].map(title => { const data = stream(title); return `<< /Length ${data.length} >>\nstream\n${data}\nendstream`; }),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 8\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return `data:application/pdf;base64,${Buffer.from(pdf).toString('base64')}`;
}
async function attachmentPreviews(page) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M12 12h40v30H28L12 54Z" fill="none" stroke="#242936" stroke-width="4"/></svg>`;
  const files = [
    { name: 'comment.svg', path: 'comment.svg', mime: 'image/svg+xml', size: svg.length, uri: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}` },
    { name: 'review.pdf', path: 'review.pdf', mime: 'application/pdf', size: 1200, uri: samplePdf() },
  ];
  await page.evaluate(files => {
    const post = data => window.dispatchEvent(new MessageEvent('message', { data }));
    post({ type: 'userMessage', text: 'SVG and PDF previews in the conversation', files });
    for (const attachment of files) post({ type: 'attachmentSaved', attachment });
  }, files);
  await page.waitForFunction(() => document.querySelectorAll('.attachment-pdf:not([hidden])').length === 2);
  await page.waitForFunction(() => [...document.querySelectorAll('.attachment-chip img')].every(img => img.complete && img.naturalWidth > 0));
}

export const LOOP_STATES = ['empty', 'running', 'parallel', 'completed', 'loop', 'loopdone', 'deferred', 'exhausted', 'tester', 'testerdone'];

export const scenarios = [
  { id: 'loops-sidebar', sidebar: true, height: 1400, focus: '#loopsModal .fs-modal-sheet', setup: loopsState('running') },
  { id: 'chat-empty' },
  ...['dictate', 'polish'].map(action => ({ id: `composer-action-${action}`, focus: '.composer', setup: async page => {
    await page.locator('#promptInput').fill('Polish this draft into a clear, concise prompt.');
    await page.locator('#micBtn').hover();
    if (action === 'polish') {
      await page.locator('#polishBtn').click();
      await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'polishResult', requestId: 1, text: 'Rewrite this draft as a clear, concise prompt.',
      } })));
      await page.locator('.toast').waitFor({ state: 'detached' });
      await page.locator('#polishBtn').hover();
    }
    await page.waitForTimeout(450);
  } })),
  { id: 'queue-usage-warning', setup: async page => {
    await page.evaluate(() => {
      const post = data => window.dispatchEvent(new MessageEvent('message', { data }));
      post({ type: 'chatLoaded', chat: { id: 'usage-review', modelId: 'claude-sonnet-5-5-high', messages: [
        { role: 'user', text: 'Check the regulatory requirements.' },
        { role: 'assistant', agent: 'claude', text: "I started checking the requirements.\nYou've hit your session limit · resets 2:10pm (Europe/Berlin)" },
      ] } });
      post({ type: 'turnQueue', chatId: 'usage-review', paused: true, turns: [{ id: 'review', text: 'Check EU regulatory requirements', modelId: 'claude-sonnet-5-5-high', attachments: [], files: [] }] });
      post({ type: 'queueUsageWarning', chatId: 'usage-review', id: 'review', agent: 'claude', text: 'Claude Sonnet is out of usage. This prompt is still in the queue.' });
    });
    await page.locator('.queue-usage-warning').waitFor();
  } },
  { id: 'attachment-previews', setup: attachmentPreviews },
  { id: 'attachment-svg-viewer', focus: '.image-lightbox', setup: async page => {
    await attachmentPreviews(page);
    const chip = page.locator('.msg-attachments .attachment-chip').first();
    await chip.focus(); await page.keyboard.press('Enter');
    await page.locator('.image-lightbox img').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('.image-lightbox').waitFor({ state: 'detached' });
    if (!await chip.evaluate(element => element === document.activeElement)) throw new Error('Preview did not restore keyboard focus');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.image-lightbox img')?.naturalWidth > 0);
    if (!await page.locator('.image-lightbox img').evaluate(element => element.clientWidth > 100 && element.clientHeight > 100)) throw new Error('SVG preview collapsed');
  } },
  { id: 'attachment-pdf-viewer', focus: '.image-lightbox', setup: async page => {
    await attachmentPreviews(page);
    await page.locator('.msg-attachments .attachment-chip').last().click();
    await page.getByText('Page 1 of 2', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Next page' }).click();
    await page.getByText('Page 2 of 2', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Previous page' }).click();
    await page.getByText('Page 1 of 2', { exact: true }).waitFor();
  } },
  { id: 'model-menu', scope: '#modelMenu', focus: '#modelMenu', setup: async page => { await page.locator('#modelPill').click(); await page.locator('.model-option').first().waitFor(); await page.waitForTimeout(700); /* the spring-open takes 0.5s */ } },
  ...['general', 'voice', 'remote', 'models'].map(tab => ({ id: `settings-${tab}`, height: 1400, focus: MODAL, setup: openSettings(tab) })),
  { id: 'settings-search', height: 1400, scope: '.cs-settings-search', focus: '.cs-settings-search', setup: async page => {
    await openSettings('general')(page);
    await page.getByRole('combobox', { name: 'Search settings' }).fill('hotkey');
    await page.getByRole('option', { name: 'Dictation hotkey Voice', exact: true }).waitFor();
  } },
  { id: 'settings-search-jump', height: 1400, scope: '.cs-search-target', focus: MODAL, setup: async page => {
    await openSettings('general')(page);
    await page.evaluate(config => window.dispatchEvent(new MessageEvent('message', { data: { type: 'fleet', services: { routing: { config, usage: {}, models: [], connected: {} } } } })), DEFAULTS);
    const input = page.getByRole('combobox', { name: 'Search settings' });
    await input.fill('confidence needed'); await input.press('Enter');
    await page.locator('[data-pane="routing"] .cs-search-target').waitFor();
    await page.waitForTimeout(400);
  } },
  ...['collapsed', 'expanded', 'empty'].map(state => ({ id: `settings-project-icons-${state}`, height: 1400, focus: MODAL, setup: async page => {
    await openSettings('general')(page);
    await page.evaluate(empty => window.dispatchEvent(new MessageEvent('message', { data: { type: 'projectIcons', projects: empty ? [] : [
      { id: 'clanker', name: 'Clanker Controller', root: 'C:/projects/clanker' },
      { id: 'visor', name: 'Visor', root: 'C:/projects/visor', icon: 'public/favicon.svg', iconUri: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"%3E%3Cpath d="m4 5 8 14 8-14" fill="none" stroke="%238ab4ff" stroke-width="3"/%3E%3C/svg%3E' },
      { id: 'long', name: 'A project with a very long name for testing compact rows', root: 'C:/projects/long', icon: 'public/assets/a-very-long-filename-for-the-project-icon.svg' },
      { id: 'plan', name: 'Planning', root: '' },
      ...Array.from({ length: 4 }, (_, i) => ({ id: `extra-${i}`, name: `Project ${i + 1}`, root: 'C:/projects/extra' })),
    ] } })), state === 'empty');
    const panel = page.locator('.cs-project-icons');
    if (await panel.evaluate(el => el.open)) throw new Error('Project icons must start collapsed');
    if (state !== 'collapsed') {
      await panel.locator('summary').focus();
      await page.keyboard.press('Enter');
      if (!await panel.evaluate(el => el.open)) throw new Error('Keyboard did not expand project icons');
    }
  } })),
  { id: 'settings-routing', height: 1400, focus: MODAL, setup: async page => {
    await openSettings('routing')(page);
    await page.evaluate(config => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'fleet', services: { routing: { config, usage: { neurons: 1200, groq_requests: 86, groq_tokens: 197631 },
        models: [], connected: { cloudflare: true, groq: true }, reset: new Date(Date.now() + 3600000).toISOString() } },
    } })), DEFAULTS);
    await page.getByText('Smart routing', { exact: true }).waitFor();
  } },
  ...LOOP_STATES.map(state => ({ id: `loops-${state}`, height: 2600, focus: MODAL, setup: loopsState(state) })),
];
