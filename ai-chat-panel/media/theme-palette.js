/* Adapt IDE colours to Clanker's existing glass tokens. Artwork and provider colours stay independent. */
(() => {
  'use strict';
  const KEYS = ['editor.background', 'editor.foreground', 'sideBar.background', 'foreground',
    'editorWidget.background', 'widget.border', 'panel.border', 'contrastBorder', 'focusBorder',
    'descriptionForeground', 'disabledForeground', 'button.background', 'button.foreground',
    'button.hoverBackground', 'textLink.foreground', 'textLink.activeForeground',
    'textCodeBlock.background', 'errorForeground', 'editorError.foreground', 'editorWarning.foreground',
    'testing.iconPassed', 'editorInfo.foreground'];

  function parse(value) {
    const hex = /^#([a-f\d]{3,4}|[a-f\d]{6}|[a-f\d]{8})$/i.exec(value?.trim());
    if (hex) {
      let s = hex[1];
      if (s.length < 5) s = [...s].map(c => c + c).join('');
      return [0, 2, 4].map(i => parseInt(s.slice(i, i + 2), 16)).concat(s.length === 8 ? parseInt(s.slice(6), 16) / 255 : 1);
    }
    const rgb = /^rgba?\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/.exec(value?.trim());
    return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] === undefined ? 1 : Number(rgb[4])] : null;
  }
  const mix = (a, b, weight) => a.slice(0, 3).map((v, i) => Math.round(v * (1 - weight) + b[i] * weight));
  const solid = (colour, background) => mix(background, colour, colour[3] ?? 1);
  const rgb = c => `rgb(${c.slice(0, 3).join(', ')})`;
  const rgba = (c, a) => `rgba(${c.slice(0, 3).join(', ')}, ${a})`;
  const luminance = c => c.slice(0, 3).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
  const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
  function readable(colour, background) {
    if (contrast(colour, background) >= 4.5) return colour;
    const target = contrast([255, 255, 255], background) > contrast([0, 0, 0], background) ? [255, 255, 255] : [0, 0, 0];
    for (let n = 1; n <= 20; n++) {
      const candidate = mix(colour, target, n / 20);
      if (contrast(candidate, background) >= 4.5) return candidate;
    }
    return target;
  }

  function palette(values, highContrast = false, lightMode = null) {
    const raw = key => parse(values[key]);
    const base = raw('editor.background') || raw('sideBar.background');
    if (!base) return {}; // Bare browser fixtures and hosts without theme variables retain the built-in palettes.
    const bg = solid(base, luminance(base) > .5 ? [255, 255, 255] : [0, 0, 0]);
    const light = lightMode ?? luminance(bg) > .45;
    const colour = (key, fallback) => raw(key) ? solid(raw(key), bg) : fallback;
    const fg = readable(colour('editor.foreground', colour('foreground', luminance(bg) > .5 ? [29, 29, 31] : [245, 245, 247])), bg);
    let panel = colour('editorWidget.background', colour('sideBar.background', mix(bg, fg, .06)));
    if (contrast(fg, panel) < 4.5) panel = bg;
    // Light glass catches light: raising it must not mix in dark label ink.
    if (light && !highContrast) panel = mix(panel, [255, 255, 255], .28);
    const text = c => contrast(c, panel) >= 4.5 && contrast(c, bg) >= 4.5 ? c : fg;
    const raised = mix(panel, light && !highContrast ? [255, 255, 255] : fg, highContrast ? .03 : light ? .38 : .07);
    let border = colour('contrastBorder', colour('widget.border', colour('panel.border', mix(panel, fg, highContrast ? .7 : light ? .12 : .2))));
    if (light && !highContrast && !raw('contrastBorder') && (raw('widget.border') || raw('panel.border'))) border = mix(panel, border, .35);
    if (highContrast && contrast(border, panel) < 3) border = fg;
    const accent = text(readable(colour('textLink.foreground', colour('focusBorder', [10, 132, 255])), bg));
    const button = colour('button.background', accent);
    const onButton = readable(colour('button.foreground', fg), button);
    const hover = colour('button.hoverBackground', mix(button, fg, .1));
    const code = colour('textCodeBlock.background', bg);
    const error = text(readable(colour('editorError.foreground', colour('errorForeground', [255, 59, 48])), bg));
    const warning = text(readable(colour('editorWarning.foreground', [255, 159, 10]), bg));
    const success = text(readable(colour('testing.iconPassed', [48, 209, 88]), bg));
    const info = text(readable(colour('editorInfo.foreground', accent), bg));
    const result = {
      '--shadow-k': highContrast ? '0' : light ? '0.18' : '1', '--well-k': highContrast ? '0' : light ? '0.12' : '1',
      '--chat-bg': rgb(bg), '--ink': fg.join(' '), '--panel': panel.join(' '),
      '--panel-raised': raised.join(' '), '--panel-deep': bg.join(' '),
      '--charcoal': rgb(panel), '--charcoal-rim': rgb(border), '--eo-border': rgb(border),
      '--eo-surface': highContrast ? rgb(panel) : rgba(panel, .9), '--eo-surface-solid': rgb(panel),
      '--eo-surface-raised': highContrast ? rgb(raised) : rgba(raised, .96),
      '--text-primary': rgb(fg), '--text-soft': rgb(fg), '--text-bright': rgb(fg),
      '--text-secondary': rgb(text(colour('descriptionForeground', mix(fg, bg, .3)))),
      '--text-tertiary': rgb(text(colour('disabledForeground', mix(fg, bg, .25)))),
      '--accent': rgb(accent), '--accent-hover': rgb(text(colour('textLink.activeForeground', accent))),
      '--strong': rgb(button), '--strong-hover': rgb(contrast(onButton, hover) >= 4.5 ? hover : button),
      '--on-strong': rgb(onButton), '--theme-button': rgb(button), '--theme-on-button': rgb(onButton),
      '--theme-on-accent': rgb(readable(fg, accent)),
      '--code-bg': rgb(contrast(fg, code) >= 4.5 ? code : bg), '--text-code': rgb(fg),
      '--rail-rest': rgb(mix(panel, fg, .15)), '--warning': rgb(warning), '--destructive': rgb(error),
    };
    for (const key of ['red-soft', 'red', 'red-strong', 'red-pale']) result[`--fg-${key}`] = rgb(error);
    for (const key of ['amber', 'orange', 'yellow']) result[`--fg-${key}`] = rgb(warning);
    for (const key of ['mint', 'mint-alt', 'mint-pale', 'green', 'sys-green', 'lime', 'lime-pale']) result[`--fg-${key}`] = rgb(success);
    result['--fg-cyan'] = rgb(info);
    return result;
  }
  if (typeof module !== 'undefined') module.exports = { parse, palette, contrast };
  if (typeof document === 'undefined') return;

  let signature = '', owned = [], applied = {}, queued = false;
  function refresh() {
    queued = false;
    const body = document.body, style = getComputedStyle(body);
    const values = Object.fromEntries(KEYS.map(key => [key, style.getPropertyValue(`--vscode-${key.replaceAll('.', '-')}`).trim()]));
    const highContrast = body.classList.contains('vscode-high-contrast') || body.classList.contains('vscode-high-contrast-light');
    const next = JSON.stringify([values, highContrast, body.classList.contains('vscode-light')]);
    if (next === signature && owned.every(key => body.style.getPropertyValue(key) === applied[key])) return;
    signature = next;
    owned.forEach(key => body.style.removeProperty(key));
    const colours = palette(values, highContrast, body.classList.contains('vscode-light') || body.classList.contains('vscode-high-contrast-light'));
    applied = colours;
    owned = Object.keys(colours);
    for (const [key, value] of Object.entries(colours)) body.style.setProperty(key, value);
    window.dispatchEvent(new Event('clanker-theme-changed'));
  }
  const schedule = () => { if (!queued) { queued = true; queueMicrotask(refresh); } };
  const observer = new MutationObserver(schedule);
  const options = { attributes: true, attributeFilter: ['style', 'class', 'data-vscode-theme-id'] };
  observer.observe(document.documentElement, options);
  observer.observe(document.body, options);
  observer.observe(document.head, { childList: true, subtree: true, characterData: true });
  refresh();
})();
