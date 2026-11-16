'use strict';
// Image markup: the user draws, highlights or types on a staged image. The composer saves the flattened PNG (what gets
// attached) next to a "<file>.markup.json" sidecar holding the original image's path and the vector marks, so the
// original is never overwritten and every CLI hears which regions the user pointed at (attachmentPrompt calls
// markupPrompt for each attachment).
const fs = require('node:fs');

const SUFFIX = '.markup.json';
const MAX_ITEMS = 400, MAX_POINTS = 2000, MAX_TEXT = 200, MAX_GROUPS = 12;
const COLORS = { '#ff3b30': 'red', '#ffd60a': 'yellow', '#30d158': 'green', '#0a84ff': 'blue', '#ffffff': 'white', '#000000': 'black' };
const KINDS = new Set(['pen', 'highlight', 'text']);

const sidecarPath = (file) => `${file}${SUFFIX}`;
const isSidecar = (name) => name.endsWith(SUFFIX);
const finite = (n) => typeof n === 'number' && Number.isFinite(n);

/** Whatever the webview sent, cut down to the shapes and sizes the prompt and the editor understand. */
function cleanMarkup(raw) {
  const width = Math.round(Number(raw?.width)), height = Math.round(Number(raw?.height));
  if (!(width > 0 && height > 0 && width <= 20000 && height <= 20000)) return null;
  const items = [];
  for (const item of Array.isArray(raw.items) ? raw.items.slice(0, MAX_ITEMS) : []) {
    if (!KINDS.has(item?.kind)) continue;
    const color = typeof item.color === 'string' && /^#[0-9a-f]{6}$/i.test(item.color) ? item.color.toLowerCase() : '#ff3b30';
    const size = finite(item.size) ? Math.min(Math.max(item.size, 1), 2000) : 8;
    if (item.kind === 'text') {
      const text = String(item.text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
      if (text && finite(item.x) && finite(item.y)) items.push({ kind: 'text', color, size, x: item.x, y: item.y, text });
    } else {
      const points = (Array.isArray(item.points) ? item.points.slice(0, MAX_POINTS) : []).filter((p) => Array.isArray(p) && finite(p[0]) && finite(p[1])).map((p) => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]);
      if (points.length) items.push({ kind: item.kind, color, size, points });
    }
  }
  return { version: 1, width, height, items };
}

function readMarkup(file) {
  try {
    const data = JSON.parse(fs.readFileSync(sidecarPath(file), 'utf8'));
    const clean = cleanMarkup(data);
    return clean && typeof data.original === 'string' ? { ...clean, original: data.original } : null;
  } catch { return null; }
}
function writeMarkup(file, original, raw) {
  const clean = cleanMarkup(raw);
  if (!clean) throw new Error('Markup has no usable size');
  fs.writeFileSync(sidecarPath(file), JSON.stringify({ ...clean, original }));
  return { ...clean, original };
}

function bounds(item, width, height) {
  if (item.kind === 'text') {
    const w = Math.min(item.text.length * item.size * 0.55, width - item.x);
    return { x0: item.x, y0: item.y, x1: item.x + Math.max(w, item.size), y1: item.y + item.size * 1.2 };
  }
  const xs = item.points.map((p) => p[0]), ys = item.points.map((p) => p[1]), pad = item.size / 2;
  return { x0: Math.min(...xs) - pad, y0: Math.min(...ys) - pad, x1: Math.max(...xs) + pad, y1: Math.max(...ys) + pad };
}
const touching = (a, b, gap) => a.x0 - gap <= b.x1 && b.x0 - gap <= a.x1 && a.y0 - gap <= b.y1 && b.y0 - gap <= a.y1;

function place(box, width, height) {
  const cx = (box.x0 + box.x1) / 2 / width, cy = (box.y0 + box.y1) / 2 / height;
  const row = cy < 1 / 3 ? 'upper' : cy > 2 / 3 ? 'lower' : 'middle', col = cx < 1 / 3 ? 'left' : cx > 2 / 3 ? 'right' : 'center';
  if (row === 'middle' && col === 'center') return 'center';
  if (row === 'middle') return col;
  return col === 'center' ? `${row} middle` : `${row} ${col}`;
}

/** Marks of one kind and colour that touch or overlap are one region. Text stays separate: its words matter. */
function regions(markup) {
  const { width, height } = markup, gap = Math.max(width, height) * 0.03, out = [];
  for (const item of markup.items) {
    const box = bounds(item, width, height);
    const found = item.kind === 'text' ? null : out.find((r) => r.kind === item.kind && r.color === item.color && touching(r.box, box, gap));
    if (found) {
      found.box = { x0: Math.min(found.box.x0, box.x0), y0: Math.min(found.box.y0, box.y0), x1: Math.max(found.box.x1, box.x1), y1: Math.max(found.box.y1, box.y1) };
      found.count++;
    } else out.push({ kind: item.kind, color: item.color, box, count: 1, text: item.text });
  }
  // Two regions can grow into each other after merging; one more pass keeps the list short.
  for (let i = 0; i < out.length; i++) for (let j = out.length - 1; j > i; j--) {
    const a = out[i], b = out[j];
    if (a.kind !== 'text' && a.kind === b.kind && a.color === b.color && touching(a.box, b.box, gap)) {
      a.box = { x0: Math.min(a.box.x0, b.box.x0), y0: Math.min(a.box.y0, b.box.y0), x1: Math.max(a.box.x1, b.box.x1), y1: Math.max(a.box.y1, b.box.y1) };
      a.count += b.count; out.splice(j, 1);
    }
  }
  return out;
}

const pct = (n, total) => Math.max(0, Math.min(100, Math.round((n / total) * 100)));
/** One line per region, in percent of the image from its top left corner, for a model that reads the picture. */
function describeRegions(markup) {
  const { width, height } = markup;
  const list = regions(markup).sort((a, b) => a.box.y0 - b.box.y0 || a.box.x0 - b.box.x0);
  const lines = list.slice(0, MAX_GROUPS).map((r, i) => {
    const colour = COLORS[r.color] || r.color, area = `x ${pct(r.box.x0, width)}-${pct(r.box.x1, width)}%, y ${pct(r.box.y0, height)}-${pct(r.box.y1, height)}% (${place(r.box, width, height)})`;
    if (r.kind === 'text') return `${i + 1}. text "${r.text}" in ${colour} at ${area}`;
    return `${i + 1}. ${colour} ${r.kind === 'highlight' ? 'highlighter over' : 'pen marks around'} ${area}`;
  });
  if (list.length > MAX_GROUPS) lines.push(`…and ${list.length - MAX_GROUPS} more marked regions.`);
  return lines;
}

/** The note added to the prompt for one attached file; empty when the file has no markup. */
function markupPrompt(file) {
  const markup = readMarkup(file);
  if (!markup?.items.length) return '';
  const lines = describeRegions(markup);
  return [`Image markup: ${file} was annotated by the user (${markup.width}×${markup.height}px). The marks show what the request is about; look at those regions first.`,
    `The unmarked original is saved at ${markup.original}. Marks, in percent of the image from its top left corner:`,
    ...lines].join('\n');
}

module.exports = { SUFFIX, sidecarPath, isSidecar, cleanMarkup, readMarkup, writeMarkup, describeRegions, markupPrompt };
