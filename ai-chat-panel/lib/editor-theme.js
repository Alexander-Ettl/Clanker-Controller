'use strict';

// The editor's own syntax colours for chat code blocks. VS Code gives webviews
// UI colours as CSS variables but no token colours, so this reads the active
// colour theme's file (following its "include" chain) plus the user's
// editor.tokenColorCustomizations, and hands Shiki a VS Code theme object.

const fs = require('node:fs');
const path = require('node:path');

/** JSON with comments and trailing commas, as theme files are written. */
function parseJsonc(text) {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i < 0) break;
      i += 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** A theme file and everything it includes, included files first. */
function loadThemeFile(file, depth = 0) {
  const json = parseJsonc(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  const base = json.include && depth < 8 ? loadThemeFile(path.resolve(path.dirname(file), json.include), depth + 1) : { colors: {}, tokenColors: [] };
  return {
    type: json.type || base.type,
    colors: { ...base.colors, ...(json.colors || {}) },
    // A .tmTheme path (plist) is left out: rare, and Shiki wants rule objects.
    tokenColors: [...base.tokenColors, ...(Array.isArray(json.tokenColors) ? json.tokenColors : [])],
  };
}

// The simple keys of editor.tokenColorCustomizations, as the scopes VS Code maps them to.
const SIMPLE_SCOPES = {
  comments: ['comment', 'punctuation.definition.comment'],
  strings: ['string'],
  keywords: ['keyword', 'keyword.control', 'storage.modifier', 'storage.type'],
  numbers: ['constant.numeric'],
  types: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class'],
  functions: ['entity.name.function', 'support.function'],
  variables: ['variable', 'entity.name.variable'],
};

function customizationRules(custom) {
  if (!custom || typeof custom !== 'object') return [];
  const rules = Array.isArray(custom.textMateRules) ? [...custom.textMateRules] : [];
  for (const [key, scope] of Object.entries(SIMPLE_SCOPES)) {
    const value = custom[key];
    if (!value) continue;
    rules.push({ scope, settings: typeof value === 'string' ? { foreground: value } : value });
  }
  return rules;
}

/** The active theme as a Shiki (VS Code format) theme object, or null if it can't be found. */
function resolveEditorTheme(vscode) {
  const themeName = vscode.workspace.getConfiguration('workbench').get('colorTheme');
  let file = null;
  let uiTheme = 'vs-dark';
  for (const extension of vscode.extensions.all) {
    const match = (extension.packageJSON?.contributes?.themes || []).find((theme) => theme.id === themeName || theme.label === themeName);
    if (match) { file = path.join(extension.extensionPath, match.path); uiTheme = match.uiTheme; break; }
  }
  if (!file) return null;
  let theme;
  try { theme = loadThemeFile(file); } catch { return null; }
  const custom = vscode.workspace.getConfiguration('editor').get('tokenColorCustomizations') || {};
  const tokenColors = [...theme.tokenColors, ...customizationRules(custom), ...customizationRules(custom[`[${themeName}]`])];
  const dark = uiTheme !== 'vs' && uiTheme !== 'hc-light';
  return {
    name: 'editor',
    type: dark ? 'dark' : 'light',
    colors: theme.colors,
    fg: theme.colors['editor.foreground'] || (dark ? '#d4d4d4' : '#1f1f1f'),
    bg: theme.colors['editor.background'] || (dark ? '#1e1e1e' : '#ffffff'),
    tokenColors,
  };
}

module.exports = { parseJsonc, loadThemeFile, customizationRules, resolveEditorTheme };
