'use strict';

// The webviews follow the IDE's light or dark colour theme through tokens on body (style.css, top). A literal
// white wash or the old charcoal written straight into a rule would stay dark-theme-only, so new colours go through
// the tokens: --ink / --sheen channels, --charcoal, --panel*, --fg-*, or light-dark() for a one-off.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const media = path.join(__dirname, '..', 'media');
const sheets = fs.readdirSync(media).filter((name) => name.endsWith('.css'));
const read = (name) => fs.readFileSync(path.join(media, name), 'utf8');
const tokenBlocks = (css) => css.replace(/(?::root,\s*body|body\.vscode-light,\s*body\.vscode-high-contrast-light)\s*\{[^}]*\}/g, '');

test('no stylesheet hard-codes the dark palette outside the theme tokens', () => {
  for (const name of sheets) {
    const css = tokenBlocks(read(name));
    assert.doesNotMatch(css, /rgba\(\s*255\s*,\s*255\s*,\s*255\s*,/, `${name}: use rgb(var(--ink) / a) or rgb(var(--sheen) / a)`);
    assert.doesNotMatch(css, /rgb\(\s*26\s*,\s*28\s*,\s*34\s*\)/, `${name}: use var(--charcoal)`);
  }
});

test('the light theme overrides every colour token the dark one declares', () => {
  const css = read('style.css');
  const block = (selector) => css.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`))[1];
  const names = (body) => new Set([...body.matchAll(/(--[a-z-]+)\s*:/g)].map((match) => match[1]));
  const dark = names(block(':root,\\s*body'));
  const light = names(block('body\\.vscode-light,\\s*body\\.vscode-high-contrast-light'));
  // Shape, motion and type tokens, and colours that read on both (the agent accents, the glass sheen), are shared.
  const shared = /^--(eo-ease|ease-spring|radius-|pill|font-|surface-|border|warning|destructive|claude-color|codex-color|gemini-color|auto-color|sheen)/;
  const missing = [...dark].filter((name) => !shared.test(name) && !light.has(name));
  assert.deepStrictEqual(missing, []);
});
