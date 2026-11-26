// Shared by the three minimal-appearance mockups: VS Code theme variables, the state switch and the icon set.
// A mockup page reads ?theme=<id>&state=<id>. The theme sets the same --vscode-* custom properties and body classes
// that a real VS Code webview receives, so the mockup CSS is written exactly as the extension's CSS would be.
(() => {
  'use strict';

  // The colour keys VS Code exposes as --vscode-<key with dots as dashes>. Values are taken from each theme's JSON
  // (Dark/Light Modern and the high-contrast themes are VS Code's built-ins; Clanker Ink is the user's theme).
  const THEMES = {
    'clanker-ink': { label: 'Clanker Ink', kind: 'vscode-dark', c: {
      'editor.background': '#121212', 'foreground': '#eeebe3', 'descriptionForeground': '#9d998e',
      'textLink.foreground': '#ff5a1f', 'focusBorder': '#ff5a1f', 'button.background': '#ff5a1f', 'button.foreground': '#121212',
      'input.background': '#1b1b1b', 'editorWidget.background': '#121212',
      'gitDecoration.addedResourceForeground': '#4cc38a', 'gitDecoration.deletedResourceForeground': '#ff6b4a',
      'editorWarning.foreground': '#e0b040', 'errorForeground': '#ff6b4a' } },
    'dark-modern': { label: 'Dark Modern', kind: 'vscode-dark', c: {
      'editor.background': '#1f1f1f', 'foreground': '#cccccc', 'descriptionForeground': '#9d9d9d',
      'textLink.foreground': '#4daafc', 'focusBorder': '#0078d4', 'button.background': '#0078d4', 'button.foreground': '#ffffff',
      'input.background': '#313131', 'editorWidget.background': '#202020',
      'gitDecoration.addedResourceForeground': '#81b88b', 'gitDecoration.deletedResourceForeground': '#c74e39',
      'editorWarning.foreground': '#cca700', 'errorForeground': '#f85149' } },
    'navy': { label: 'Navy (custom dark)', kind: 'vscode-dark', c: {
      'editor.background': '#172437', 'foreground': '#e4edf7', 'descriptionForeground': '#9fb2c8',
      'textLink.foreground': '#8acbff', 'focusBorder': '#8acbff', 'button.background': '#8acbff', 'button.foreground': '#172437',
      'input.background': '#213149', 'editorWidget.background': '#213149',
      'gitDecoration.addedResourceForeground': '#7fd69b', 'gitDecoration.deletedResourceForeground': '#ff8b7a',
      'editorWarning.foreground': '#f2c46d', 'errorForeground': '#ff8b7a' } },
    'light-modern': { label: 'Light Modern', kind: 'vscode-light', c: {
      'editor.background': '#ffffff', 'foreground': '#3b3b3b', 'descriptionForeground': '#3b3b3b',
      'textLink.foreground': '#005fb8', 'focusBorder': '#005fb8', 'button.background': '#005fb8', 'button.foreground': '#ffffff',
      'input.background': '#ffffff', 'editorWidget.background': '#f8f8f8',
      'gitDecoration.addedResourceForeground': '#587c0c', 'gitDecoration.deletedResourceForeground': '#ad0707',
      'editorWarning.foreground': '#bf8803', 'errorForeground': '#f85149' } },
    'solarized-light': { label: 'Solarized Light', kind: 'vscode-light', c: {
      'editor.background': '#fdf6e3', 'foreground': '#586e75', 'descriptionForeground': '#717171',
      'textLink.foreground': '#006ab1', 'focusBorder': '#b49471', 'button.background': '#ac9d57', 'button.foreground': '#ffffff',
      'input.background': '#ddd6c1', 'editorWidget.background': '#eee8d5',
      'gitDecoration.addedResourceForeground': '#587c0c', 'gitDecoration.deletedResourceForeground': '#ad0707',
      'editorWarning.foreground': '#bf8803', 'errorForeground': '#a1260d' } },
    'hc-dark': { label: 'High Contrast Dark', kind: 'vscode-high-contrast', c: {
      'editor.background': '#000000', 'foreground': '#ffffff', 'descriptionForeground': '#ffffff',
      'textLink.foreground': '#21a6ff', 'focusBorder': '#f38518', 'contrastBorder': '#6fc3df', 'contrastActiveBorder': '#f38518',
      'button.background': '#000000', 'button.foreground': '#ffffff', 'input.background': '#000000', 'editorWidget.background': '#0c141f',
      'gitDecoration.addedResourceForeground': '#a1e3ad', 'gitDecoration.deletedResourceForeground': '#c74e39',
      'editorWarning.foreground': '#ffd370', 'errorForeground': '#f48771' } },
    'hc-light': { label: 'High Contrast Light', kind: 'vscode-high-contrast-light', c: {
      'editor.background': '#ffffff', 'foreground': '#292929', 'descriptionForeground': '#292929',
      'textLink.foreground': '#0f4a85', 'focusBorder': '#006bbd', 'contrastBorder': '#0f4a85', 'contrastActiveBorder': '#006bbd',
      'button.background': '#0f4a85', 'button.foreground': '#ffffff', 'input.background': '#ffffff', 'editorWidget.background': '#ffffff',
      'gitDecoration.addedResourceForeground': '#374e06', 'gitDecoration.deletedResourceForeground': '#ad0707',
      'editorWarning.foreground': '#895503', 'errorForeground': '#b5200d' } },
  };
  const STATES = ['empty', 'chat', 'steps', 'running', 'model', 'more', 'settings'];

  // 24px stroke icons (drawn for these mockups). `f:` marks a filled shape.
  const ICONS = {
    plus: 'M12 5v14M5 12h14',
    arrowUp: 'M12 19V5M5.5 11.5 12 5l6.5 6.5',
    mic: 'M9 6a3 3 0 0 1 6 0v5a3 3 0 0 1-6 0zM5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21',
    stop: 'f:M7 8.5A1.5 1.5 0 0 1 8.5 7h7A1.5 1.5 0 0 1 17 8.5v7a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 7 15.5z',
    newChat: 'M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5M17.6 3.6a2 2 0 0 1 2.8 2.8L12 14.8l-3.6.8.8-3.6z',
    history: 'M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5M3.5 4v4.5H8M12 7.5V12l3 2',
    more: 'f:M5 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm7 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm7 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z',
    chevDown: 'M6.5 9.5 12 15l5.5-5.5',
    chevRight: 'M9.5 6.5 15 12l-5.5 5.5',
    search: 'M10.5 4a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM20 20l-4.8-4.8',
    file: 'M13.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5zM13.5 3v5.5H19',
    pencil: 'M4 20h4.2L19.5 8.7a2.1 2.1 0 0 0-3-3L5.2 17v3zM14.5 7.5l3 3',
    terminal: 'M5 7l5 5-5 5M12.5 17.5H19',
    check: 'M5 12.5l4.5 4.5L19 7.5',
    copy: 'M9 9h9a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2zM15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3',
    retry: 'M20 12a8 8 0 1 1-2.4-5.7L20 8.5M20 4v4.5h-4.5',
    sparkle: 'f:M12 2.5c.5 4.6 2.4 6.9 7 7.5v.9c-4.6.6-6.5 2.9-7 7.6h-.9c-.6-4.7-2.5-7-7.1-7.6V10c4.6-.6 6.5-2.9 7.1-7.5z',
    globe: 'M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17zM3.5 12h17M12 3.5c2.4 2.4 3.4 5.2 3.4 8.5s-1 6.1-3.4 8.5c-2.4-2.4-3.4-5.2-3.4-8.5s1-6.1 3.4-8.5z',
    sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4',
    popout: 'M14 4h6v6M20 4l-8.5 8.5M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4',
    loop: 'M16.5 3.5 20 7l-3.5 3.5M4 11.5V10a3 3 0 0 1 3-3h13M7.5 20.5 4 17l3.5-3.5M20 12.5V14a3 3 0 0 1-3 3H4',
    clock: 'M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17zM12 7.5V12l3 2',
    queue: 'M4 6h12M4 11h12M4 16h7M15.5 15.5h5M18 13v5',
    shield: 'M12 3.5 19 6v5.5c0 4.3-2.9 7.6-7 9-4.1-1.4-7-4.7-7-9V6z',
    image: 'M5 4.5h14a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18V6A1.5 1.5 0 0 1 5 4.5zM20.5 15.5l-5-5-9 9M9 8a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z',
    at: 'M15.5 12a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0zm0 0v1.3a2.6 2.6 0 0 0 5.2 0V12a8.7 8.7 0 1 0-3.4 6.9',
    folder: 'M3.5 7.5A2 2 0 0 1 5.5 5.5h3.7l2 2h7.3a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z',
    bolt: 'M13 3 5 13.5h6L10.5 21 19 10.5h-6z',
    close: 'M6.5 6.5l11 11M17.5 6.5l-11 11',
    paperclip: 'M20 11.5l-7.8 7.8a5 5 0 0 1-7.1-7.1l8.3-8.3a3.3 3.3 0 0 1 4.7 4.7l-8.3 8.3a1.7 1.7 0 0 1-2.4-2.4l7.6-7.6',
    layout: 'M4.5 4.5h15v15h-15zM10 4.5v15',
    sun: 'M12 8.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7zM12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4',
  };

  const params = new URLSearchParams(location.search);
  const theme = THEMES[params.get('theme')] ? params.get('theme') : 'clanker-ink';
  const state = STATES.includes(params.get('state')) ? params.get('state') : 'chat';

  function applyTheme(id) {
    const { kind, c } = THEMES[id];
    const root = document.documentElement.style;
    for (const [key, value] of Object.entries(c)) root.setProperty('--vscode-' + key.replaceAll('.', '-'), value);
    // VS Code always provides the font variables; these are its Linux and Windows defaults.
    root.setProperty('--vscode-font-family', 'system-ui, "Ubuntu", "Segoe UI", "Droid Sans", sans-serif');
    root.setProperty('--vscode-editor-font-family', '"Droid Sans Mono", "Cascadia Mono", "DejaVu Sans Mono", monospace');
    document.body.classList.add(kind);
    if (kind === 'vscode-high-contrast-light') document.body.classList.add('vscode-high-contrast');
    document.body.dataset.vscodeThemeKind = kind;
    document.body.dataset.vscodeThemeId = THEMES[id].label;
    if (!kind.includes('high-contrast')) readableInks(c);
  }

  // Secondary text and diff colours must stay at 4.5:1 on the most tinted surface (--t2), whatever the theme does.
  // The extension's media/theme-palette.js already does this for the classic look; minimal mode would reuse it.
  const hex = v => [1, 3, 5].map(i => parseInt(v.slice(i, i + 2), 16));
  const mix = (a, b, w) => a.map((v, i) => Math.round(v * (1 - w) + b[i] * w));
  const lum = c => c.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((s, v, i) => s + v * [.2126, .7152, .0722][i], 0);
  const contrast = (a, b) => (Math.max(lum(a), lum(b)) + .05) / (Math.min(lum(a), lum(b)) + .05);
  function readableInks(c) {
    const bg = hex(c['editor.background']), fg = hex(c.foreground);
    const surface = mix(bg, fg, .085);
    const lift = (colour, floor = 4.6) => {
      for (let w = 0; w <= 1; w += .05) { const next = mix(colour, fg, w); if (contrast(next, surface) >= floor) return next; }
      return fg;
    };
    // Themes such as Light Modern give secondary text the foreground colour; start from a softer ink so hierarchy survives.
    let muted = hex(c.descriptionForeground);
    if (contrast(muted, fg) < 1.4) muted = mix(fg, bg, .4);
    const set = (name, value) => document.body.style.setProperty(name, `rgb(${value.join(' ')})`);
    set('--muted', lift(muted));
    set('--add', lift(hex(c['gitDecoration.addedResourceForeground'])));
    set('--del', lift(hex(c['gitDecoration.deletedResourceForeground'])));
    set('--warn', lift(hex(c['editorWarning.foreground'])));
  }

  function icon(name) {
    const d = ICONS[name];
    if (!d) return '';
    const filled = d.startsWith('f:');
    return `<svg viewBox="0 0 24 24" aria-hidden="true" ${filled ? 'fill="currentColor"' : 'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"'}><path d="${filled ? d.slice(2) : d}"/></svg>`;
  }

  function hydrate(root = document) {
    for (const el of root.querySelectorAll('[data-i]')) el.innerHTML = icon(el.dataset.i);
    for (const el of root.querySelectorAll('[data-agent]')) el.innerHTML = window.AGENT_ICONS?.[el.dataset.agent] || '';
    if (window.CLANKER_MARK) {
      const { viewBox, d } = window.CLANKER_MARK;
      for (const el of root.querySelectorAll('[data-mark]')) el.innerHTML = `<svg viewBox="${viewBox}" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="${d}"/></svg>`;
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    applyTheme(theme);
    document.body.dataset.state = state;
    hydrate();
  });
  window.MOCK = { THEMES, STATES, theme, state, icon };
})();
