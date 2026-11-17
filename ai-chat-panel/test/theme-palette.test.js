'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, palette, contrast } = require('../media/theme-palette');

test('IDE palette parsing and absent-host fallback', () => {
  assert.deepEqual(parse('#abc'), [170, 187, 204, 1]);
  assert.deepEqual(parse('#0008'), [0, 0, 0, 136 / 255]);
  assert.deepEqual(parse('rgba(12, 24, 36, 0.5)'), [12, 24, 36, .5]);
  assert.equal(parse('not a colour'), null);
  assert.deepEqual(palette({}), {});
});

test('coloured host surfaces, buttons and status text stay readable without recolouring artwork', () => {
  for (const background of ['#18263a', '#fff4dc', '#808080']) {
    const colours = palette({ 'editor.background': background, 'editor.foreground': '#888888',
      'button.background': '#653589', 'button.foreground': '#68388b', 'editorError.foreground': '#777777' });
    assert.equal(colours['--chat-bg'], `rgb(${parse(background).slice(0, 3).join(', ')})`);
    assert.ok(contrast(parse(colours['--text-primary']), parse(colours['--chat-bg'])) >= 4.5);
    assert.ok(contrast(parse(colours['--text-primary']), parse(colours['--charcoal'])) >= 4.5);
    assert.ok(contrast(parse(colours['--on-strong']), parse(colours['--strong'])) >= 4.5);
    assert.ok(contrast(parse(colours['--fg-red']), parse(colours['--chat-bg'])) >= 4.5);
    assert.equal(colours['--claude-color'], undefined);
    assert.equal(colours['--sheen'], undefined);
  }
});

test('transparent host panels composite over the editor; high contrast surfaces are opaque', () => {
  const values = { 'editor.background': '#000000', 'editor.foreground': '#ffffff', 'editorWidget.background': '#ffffff20', 'contrastBorder': '#ffff00' };
  const colours = palette(values, true);
  assert.equal(colours['--charcoal'], 'rgb(32, 32, 32)');
  assert.equal(colours['--eo-surface'], colours['--charcoal']);
  assert.equal(colours['--charcoal-rim'], 'rgb(255, 255, 0)');
  const transparent = palette({ ...values, contrastBorder: '#00000000' }, true);
  assert.ok(contrast(parse(transparent['--charcoal-rim']), parse(transparent['--charcoal'])) >= 3);
});

test('light elevation brightens tinted panels while dark materials retain their previous values', () => {
  const values = { 'editor.background': '#e6e7ee', 'editorWidget.background': '#d9dbe5', 'editor.foreground': '#38405e' };
  const light = palette(values, false, true);
  const panel = light['--panel'].split(' ').map(Number), raised = light['--panel-raised'].split(' ').map(Number);
  assert.ok(panel.every((v, i) => v >= [217, 219, 229][i]));
  assert.ok(raised.every((v, i) => v >= panel[i]));
  assert.ok(contrast(parse(light['--text-primary']), raised) >= 4.5);
  assert.equal(light['--shadow-k'], '0.18');
  const dark = palette({ 'editor.background': '#172437', 'editorWidget.background': '#213149', 'editor.foreground': '#e4edf7' }, false, false);
  assert.equal(dark['--panel'], '33 49 73');
  assert.equal(dark['--panel-raised'], '47 62 85');
  assert.equal(dark['--shadow-k'], '1');
  assert.equal(palette(values, true, true)['--shadow-k'], '0');
});
