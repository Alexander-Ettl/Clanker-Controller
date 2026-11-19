#!/usr/bin/env node
// Generates the two colour themes from the palette of clankercontroller.com (site/public/site.css :root) and checks contrast.
//   node clanker-theme/build.mjs
// Surfaces, rules, the accent and the selection use the site's values as they are. Syntax text needs 4.5:1 on its background,
// which the site's orange, violet and blue do not reach on paper, so those hues are darkened (paper) or lightened (ink) until
// they do. The script fails if any text colour ends up below 4.5:1, so a palette edit cannot quietly ship unreadable code.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));

// site.css :root
const SITE = { paper: '#eeebe3', ink: '#121212', mute: '#5e5b53', accent: '#ff5a1f', claude: '#d97757', codex: '#7a6cf0', agy: '#2f9be0' };
// site.css .band (the dark section): label grey, body grey, code text
const BAND = { label: '#9d998e', soft: '#b5b1a6', code: '#ece9e0' };

const hex = (n) => `#${[n[0], n[1], n[2]].map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;
const rgb = (h) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v + (y[i] - v) * t)); };
const lum = (h) => { const [r, g, b] = rgb(h).map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return .2126 * r + .7152 * g + .0722 * b; };
export const contrast = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((p, q) => q - p); return (hi + .05) / (lo + .05); };
/** Moves `c` toward `toward` in small steps until it reads at `min`:1 on `bg`. Colours that already pass are returned unchanged. */
const readable = (c, bg, toward, min = 4.6) => { for (let t = 0; t <= 1.0001; t += .02) { const m = mix(c, toward, t); if (contrast(m, bg) >= min) return m; } return toward; };
const alpha = (h, a) => `${h}${Math.round(a * 255).toString(16).padStart(2, '0')}`;

function palette(kind) {
  const light = kind === 'paper';
  const bg = light ? SITE.paper : SITE.ink;
  const fg = light ? SITE.ink : SITE.paper;
  const pull = fg; // direction that raises contrast
  const hue = (c) => readable(c, bg, pull);
  return {
    light, bg, fg,
    mute: light ? SITE.mute : BAND.label,
    soft: light ? mix(SITE.paper, SITE.ink, .08) : mix(SITE.ink, SITE.paper, .07), // a tint of the page for inactive tabs, hovers and the list selection
    deep: light ? mix(SITE.paper, SITE.ink, .14) : mix(SITE.ink, SITE.paper, .13),
    rule: light ? SITE.ink : BAND.label,
    hair: light ? alpha(SITE.ink, .2) : alpha(SITE.paper, .2), // site.css --rule
    accent: SITE.accent,
    onAccent: SITE.ink,
    // syntax: the site's accent and three agent hues
    keyword: hue(SITE.accent), string: hue(SITE.claude), func: hue(SITE.codex), type: hue(SITE.agy),
    number: hue(mix(SITE.accent, SITE.claude, .5)),
    comment: light ? SITE.mute : BAND.label,
    green: hue(light ? '#2f8a5b' : '#4cc38a'), red: hue(light ? '#d03a1a' : '#ff6b4a'), yellow: hue(light ? '#b07a00' : '#e0b040'), cyan: hue(light ? '#0e8a94' : '#3cc7d1'),
  };
}

function theme(kind) {
  const p = palette(kind);
  const { bg, fg, mute, soft, deep, rule, hair, accent, onAccent } = p;
  const sel = alpha(accent, p.light ? .32 : .38);
  const colors = {
    focusBorder: accent, foreground: fg, descriptionForeground: mute, errorForeground: p.red, 'icon.foreground': fg,
    'selection.background': sel, 'textLink.foreground': p.light ? p.keyword : accent, 'textLink.activeForeground': accent,
    'textCodeBlock.background': soft, 'textBlockQuote.border': accent, 'textSeparator.foreground': rule, 'widget.shadow': '#00000000',
    // buttons: the site's .btn.primary (accent fill, ink text, ink hairline)
    'button.background': accent, 'button.foreground': onAccent, 'button.border': p.light ? SITE.ink : accent, 'button.hoverBackground': mix(accent, p.light ? '#ffffff' : '#ffffff', .15),
    'button.secondaryBackground': soft, 'button.secondaryForeground': fg, 'button.secondaryHoverBackground': deep,
    'badge.background': accent, 'badge.foreground': onAccent, 'progressBar.background': accent,
    // inputs
    'input.background': p.light ? '#f7f5f0' : '#1b1b1b', 'input.foreground': fg, 'input.border': rule, 'input.placeholderForeground': mute,
    'inputOption.activeBorder': accent, 'inputOption.activeBackground': alpha(accent, .25), 'inputValidation.errorBorder': p.red, 'inputValidation.warningBorder': p.yellow, 'inputValidation.infoBorder': p.type,
    'dropdown.background': bg, 'dropdown.foreground': fg, 'dropdown.border': rule, 'dropdown.listBackground': bg,
    'checkbox.background': bg, 'checkbox.border': rule, 'checkbox.foreground': fg,
    // lists and trees
    'list.activeSelectionBackground': accent, 'list.activeSelectionForeground': onAccent, 'list.activeSelectionIconForeground': onAccent,
    'list.inactiveSelectionBackground': deep, 'list.inactiveSelectionForeground': fg,
    'list.hoverBackground': soft, 'list.hoverForeground': fg, 'list.focusBackground': deep, 'list.focusOutline': accent,
    'list.highlightForeground': p.keyword, 'list.errorForeground': p.red, 'list.warningForeground': p.yellow, 'list.dropBackground': alpha(accent, .2),
    'tree.indentGuidesStroke': hair,
    // window chrome: ink bars, as the site's dark band and code blocks
    'titleBar.activeBackground': SITE.ink, 'titleBar.activeForeground': SITE.paper, 'titleBar.inactiveBackground': SITE.ink, 'titleBar.inactiveForeground': BAND.label, 'titleBar.border': SITE.ink,
    'menubar.selectionBackground': accent, 'menubar.selectionForeground': onAccent,
    'menu.background': bg, 'menu.foreground': fg, 'menu.selectionBackground': accent, 'menu.selectionForeground': onAccent, 'menu.separatorBackground': rule, 'menu.border': rule,
    'statusBar.background': SITE.ink, 'statusBar.foreground': SITE.paper, 'statusBar.border': SITE.ink, 'statusBar.noFolderBackground': SITE.ink, 'statusBar.noFolderForeground': SITE.paper,
    'statusBar.debuggingBackground': accent, 'statusBar.debuggingForeground': onAccent,
    'statusBarItem.hoverBackground': '#ffffff22', 'statusBarItem.remoteBackground': accent, 'statusBarItem.remoteForeground': onAccent, 'statusBarItem.prominentBackground': accent, 'statusBarItem.prominentForeground': onAccent,
    // activity bar and side bar
    'activityBar.background': bg, 'activityBar.foreground': fg, 'activityBar.inactiveForeground': mute, 'activityBar.border': rule,
    'activityBar.activeBorder': accent, 'activityBar.activeBackground': soft, 'activityBarBadge.background': accent, 'activityBarBadge.foreground': onAccent,
    'sideBar.background': bg, 'sideBar.foreground': fg, 'sideBar.border': rule, 'sideBarTitle.foreground': fg,
    'sideBarSectionHeader.background': soft, 'sideBarSectionHeader.foreground': fg, 'sideBarSectionHeader.border': rule,
    // editor groups and tabs
    'editorGroup.border': rule, 'editorGroupHeader.tabsBackground': soft, 'editorGroupHeader.tabsBorder': rule, 'editorGroupHeader.noTabsBackground': bg,
    'tab.activeBackground': bg, 'tab.activeForeground': fg, 'tab.activeBorderTop': accent, 'tab.inactiveBackground': soft, 'tab.inactiveForeground': mute,
    'tab.border': rule, 'tab.hoverBackground': bg, 'tab.unfocusedActiveBackground': bg, 'tab.unfocusedInactiveBackground': soft, 'tab.unfocusedActiveForeground': mute,
    // editor
    'editor.background': bg, 'editor.foreground': fg, 'editorLineNumber.foreground': p.light ? mix(SITE.mute, SITE.paper, .35) : mix(BAND.label, SITE.ink, .35), 'editorLineNumber.activeForeground': fg,
    'editor.selectionBackground': sel, 'editor.inactiveSelectionBackground': alpha(accent, .16), 'editor.selectionHighlightBackground': alpha(accent, .16),
    'editor.wordHighlightBackground': alpha(p.type, .2), 'editor.wordHighlightStrongBackground': alpha(accent, .24),
    'editor.findMatchBackground': alpha(accent, .45), 'editor.findMatchHighlightBackground': alpha(accent, .22), 'editor.findMatchBorder': accent,
    'editor.lineHighlightBackground': soft, 'editor.lineHighlightBorder': '#00000000', 'editorCursor.foreground': accent,
    'editorWhitespace.foreground': hair, 'editorIndentGuide.background1': hair, 'editorIndentGuide.activeBackground1': rule, 'editorRuler.foreground': hair,
    'editorBracketHighlight.foreground1': p.keyword, 'editorBracketHighlight.foreground2': p.func, 'editorBracketHighlight.foreground3': p.type, 'editorBracketHighlight.foreground4': p.green, 'editorBracketHighlight.foreground5': p.number, 'editorBracketHighlight.foreground6': p.string, 'editorBracketHighlight.unexpectedBracket.foreground': p.red,
    'editorBracketMatch.background': alpha(accent, .2), 'editorBracketMatch.border': accent,
    'editorLink.activeForeground': accent, 'editorCodeLens.foreground': mute, 'editorGutter.background': bg,
    'editorError.foreground': p.red, 'editorWarning.foreground': p.yellow, 'editorInfo.foreground': p.type, 'editorHint.foreground': p.green,
    'editorOverviewRuler.border': rule, 'editorOverviewRuler.errorForeground': p.red, 'editorOverviewRuler.warningForeground': p.yellow,
    'editorWidget.background': bg, 'editorWidget.foreground': fg, 'editorWidget.border': rule, 'editorSuggestWidget.background': bg, 'editorSuggestWidget.border': rule,
    'editorSuggestWidget.foreground': fg, 'editorSuggestWidget.selectedBackground': accent, 'editorSuggestWidget.selectedForeground': onAccent, 'editorSuggestWidget.highlightForeground': p.keyword,
    'editorHoverWidget.background': bg, 'editorHoverWidget.border': rule, 'editorHoverWidget.statusBarBackground': soft,
    'peekView.border': accent, 'peekViewEditor.background': soft, 'peekViewResult.background': bg, 'peekViewTitle.background': soft, 'peekViewTitleLabel.foreground': fg,
    'peekViewResult.selectionBackground': accent, 'peekViewResult.selectionForeground': onAccent,
    'breadcrumb.foreground': mute, 'breadcrumb.focusForeground': fg, 'breadcrumb.activeSelectionForeground': fg, 'breadcrumbPicker.background': bg,
    'scrollbar.shadow': '#00000000', 'scrollbarSlider.background': alpha(p.light ? SITE.ink : SITE.paper, .22), 'scrollbarSlider.hoverBackground': alpha(p.light ? SITE.ink : SITE.paper, .38), 'scrollbarSlider.activeBackground': alpha(accent, .7),
    'minimap.background': bg, 'minimap.selectionHighlight': accent, 'minimap.findMatchHighlight': accent,
    // diff and git
    'diffEditor.insertedTextBackground': alpha(p.green, .2), 'diffEditor.removedTextBackground': alpha(p.red, .2),
    'gitDecoration.modifiedResourceForeground': p.yellow, 'gitDecoration.addedResourceForeground': p.green, 'gitDecoration.untrackedResourceForeground': p.green, 'gitDecoration.deletedResourceForeground': p.red,
    'gitDecoration.conflictingResourceForeground': p.keyword, 'gitDecoration.ignoredResourceForeground': mute,
    'editorGutter.addedBackground': p.green, 'editorGutter.modifiedBackground': p.type, 'editorGutter.deletedBackground': p.red,
    // panel, terminal, notifications, quick input
    'panel.background': bg, 'panel.border': rule, 'panelTitle.activeForeground': fg, 'panelTitle.activeBorder': accent, 'panelTitle.inactiveForeground': mute,
    'terminal.background': bg, 'terminal.foreground': fg, 'terminalCursor.foreground': accent, 'terminal.selectionBackground': sel,
    'terminal.ansiBlack': SITE.ink, 'terminal.ansiRed': p.red, 'terminal.ansiGreen': p.green, 'terminal.ansiYellow': p.yellow, 'terminal.ansiBlue': p.type, 'terminal.ansiMagenta': p.func, 'terminal.ansiCyan': p.cyan, 'terminal.ansiWhite': p.light ? SITE.mute : SITE.paper,
    'terminal.ansiBrightBlack': p.light ? SITE.mute : BAND.label, 'terminal.ansiBrightRed': p.red, 'terminal.ansiBrightGreen': p.green, 'terminal.ansiBrightYellow': p.yellow, 'terminal.ansiBrightBlue': p.type, 'terminal.ansiBrightMagenta': p.func, 'terminal.ansiBrightCyan': p.cyan, 'terminal.ansiBrightWhite': p.light ? SITE.ink : '#ffffff',
    'notifications.background': bg, 'notifications.foreground': fg, 'notifications.border': rule, 'notificationCenterHeader.background': soft, 'notificationLink.foreground': p.light ? p.keyword : accent,
    'quickInput.background': bg, 'quickInput.foreground': fg, 'quickInputList.focusBackground': accent, 'quickInputList.focusForeground': onAccent, 'quickInputTitle.background': soft,
    'pickerGroup.foreground': p.keyword, 'pickerGroup.border': rule,
    'settings.headerForeground': fg, 'settings.modifiedItemIndicator': accent, 'settings.checkboxBackground': bg, 'settings.checkboxBorder': rule, 'settings.textInputBackground': p.light ? '#f7f5f0' : '#1b1b1b', 'settings.textInputBorder': rule,
    'extensionButton.prominentBackground': accent, 'extensionButton.prominentForeground': onAccent, 'extensionButton.prominentHoverBackground': mix(accent, '#ffffff', .15),
    'banner.background': soft, 'banner.foreground': fg, 'banner.iconForeground': accent,
  };
  const t = (name, scope, foreground, fontStyle) => ({ name, scope, settings: { foreground, ...(fontStyle ? { fontStyle } : {}) } });
  const tokenColors = [
    t('Comment', ['comment', 'punctuation.definition.comment'], p.comment, 'italic'),
    t('Keyword', ['keyword', 'storage', 'storage.type', 'keyword.control', 'keyword.operator.new', 'keyword.operator.expression', 'keyword.operator.logical.python', 'variable.language.this'], p.keyword),
    t('Operator', ['keyword.operator', 'punctuation.separator', 'punctuation.terminator', 'punctuation.accessor'], fg),
    t('String', ['string', 'punctuation.definition.string', 'string.template', 'markup.inline.raw'], p.string),
    t('Number and constant', ['constant.numeric', 'constant.language', 'constant.character', 'support.constant'], p.number),
    t('Function', ['entity.name.function', 'support.function', 'meta.function-call entity.name.function', 'meta.method-call'], p.func),
    t('Type and class', ['entity.name.type', 'entity.name.class', 'support.type', 'support.class', 'entity.other.inherited-class', 'entity.name.namespace', 'meta.type.annotation'], p.type),
    t('Variable', ['variable', 'variable.other', 'meta.definition.variable'], fg),
    t('Parameter', ['variable.parameter'], fg, 'italic'),
    t('Property', ['variable.other.property', 'variable.other.object.property', 'support.variable.property', 'meta.object-literal.key'], fg),
    t('JSON key', ['support.type.property-name', 'support.type.property-name.json'], p.type),
    t('Tag', ['entity.name.tag', 'meta.tag', 'punctuation.definition.tag'], p.keyword),
    t('Attribute', ['entity.other.attribute-name'], p.func),
    t('Regex', ['string.regexp'], p.number),
    t('Escape', ['constant.character.escape'], p.keyword),
    t('Decorator', ['meta.decorator', 'entity.name.function.decorator', 'punctuation.decorator'], p.func),
    t('Markdown heading', ['markup.heading', 'entity.name.section'], p.keyword, 'bold'),
    t('Markdown bold', ['markup.bold'], fg, 'bold'), t('Markdown italic', ['markup.italic'], fg, 'italic'),
    t('Markdown link', ['markup.underline.link', 'string.other.link'], p.type),
    t('Markdown quote', ['markup.quote'], p.comment, 'italic'),
    t('Diff inserted', ['markup.inserted'], p.green), t('Diff deleted', ['markup.deleted'], p.red), t('Diff changed', ['markup.changed'], p.yellow),
    t('Invalid', ['invalid', 'invalid.illegal'], p.red),
  ];
  const semanticTokenColors = {
    function: p.func, method: p.func, class: p.type, interface: p.type, type: p.type, enum: p.type, namespace: p.type, typeParameter: p.type,
    parameter: { foreground: fg, italic: true }, property: fg, variable: fg, 'variable.readonly': p.number, enumMember: p.number, keyword: p.keyword, comment: { foreground: p.comment, italic: true },
  };
  // Every text colour in the syntax set must read on the editor background.
  for (const [name, c] of Object.entries({ keyword: p.keyword, string: p.string, func: p.func, type: p.type, number: p.number, comment: p.comment, green: p.green, red: p.red, yellow: p.yellow, cyan: p.cyan, mute })) {
    const ratio = contrast(c, bg);
    if (ratio < 4.5) throw new Error(`${kind}: ${name} ${c} is ${ratio.toFixed(2)}:1 on ${bg}`);
  }
  for (const [name, [a, b]] of Object.entries({ 'selected list row': [onAccent, accent], 'button': [onAccent, accent], 'status bar': [SITE.paper, SITE.ink], 'inactive tab': [mute, soft] })) {
    const ratio = contrast(a, b);
    if (ratio < 4.5) throw new Error(`${kind}: ${name} is ${ratio.toFixed(2)}:1`);
  }
  return {
    name: kind === 'paper' ? 'Clanker Paper' : 'Clanker Ink',
    type: p.light ? 'light' : 'dark', semanticHighlighting: true, colors, tokenColors, semanticTokenColors,
    _palette: p,
  };
}

fs.mkdirSync(path.join(dir, 'themes'), { recursive: true });
const report = [];
for (const kind of ['paper', 'ink']) {
  const { _palette: p, ...out } = theme(kind);
  fs.writeFileSync(path.join(dir, 'themes', `clanker-${kind}-color-theme.json`), `${JSON.stringify({ $schema: 'vscode://schemas/color-theme', ...out }, null, 2)}\n`);
  report.push(`${out.name}: bg ${p.bg} fg ${p.fg} | keyword ${p.keyword} string ${p.string} function ${p.func} type ${p.type} number ${p.number} comment ${p.comment}`);
}
console.log(report.join('\n'));
