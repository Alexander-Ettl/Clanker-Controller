const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '../media/glass-ui.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/* glass-ui.css is paint only and must never apply without the engine (body.lg-on) or in high contrast. Every top-level
   rule therefore starts at the gate; the nested rules inside the big block inherit it. */
test('every rule in glass-ui.css sits behind the lg-on gate that excludes high contrast', () => {
  const gate = 'body.lg-on';
  let depth = 0, head = '';
  const heads = [];
  for (const ch of css) {
    if (ch === '{') { if (depth === 0) heads.push(head.trim()); depth++; head = ''; }
    else if (ch === '}') { depth--; head = ''; }
    else if (depth === 0) head += ch;
  }
  assert.ok(heads.length >= 3);
  for (const h of heads) {
    assert.ok(h.startsWith(gate), `ungated rule: ${h}`);
    assert.ok(/:not\(\.vscode-high-contrast, \.vscode-high-contrast-light\)|\.vscode-light:not\(\.vscode-high-contrast-light\)/.test(h), `high contrast is not excluded: ${h}`);
  }
});

test('glass-ui.css adds no backdrop blur on small controls (paint only, see the file header)', () => {
  const blurs = css.match(/[^;{}]*backdrop-filter:[^;]*;/g) || [];
  // The overlay, the search bar and the sheet reset are the only backdrop filters it may touch.
  for (const b of blurs) assert.match(b, /blur\(2[0-9]px\)|blur\(1[0-9]px\)|none/, b);
  assert.ok(blurs.length <= 6, `too many backdrop filters: ${blurs.length}`);
});

test('the webview HTML links glass-ui.css after the other stylesheets', () => {
  const ext = fs.readFileSync(path.join(__dirname, '../extension.js'), 'utf8');
  const order = ['${styleUri}', '${settingsStyleUri}', '${attachmentDocsStyleUri}', '${glassUiStyleUri}'].map((s) => ext.indexOf(`<link rel="stylesheet" href="${s}">`));
  assert.ok(order.every((i) => i > 0), 'a stylesheet link is missing');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'glass-ui.css must come last so it wins');
  assert.ok(fs.existsSync(path.join(__dirname, '../media/glass-ui.css')));
});
