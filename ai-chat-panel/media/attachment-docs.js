/* Previews for text and code, CSV/TSV tables, Word and Excel files, audio and video attachments. Everything is read in
   this page from the attachment's own URI: nothing is uploaded, the original file is never changed and the CLI still
   receives the original. Readers are bounded (a few hundred KB of text, 25 MB for Office files). */
(() => {
  const TEXT_EXT = /\.(jsonl?|md|markdown|txt|log|ya?ml|toml|xml|html?|css|scss|[cm]?js|jsx|tsx?|py|ps1|sh|bat|cmd|sql|ini|cfg|conf|env|rs|go|java|kt|cs|c|h|cpp|hpp|rb|php|lua|swift|vue|svelte|astro)$/i;
  const TEXT_LIMIT = 256 * 1024, THUMB_LIMIT = 64 * 1024, OFFICE_LIMIT = 25 * 1024 * 1024, PART_LIMIT = 16 * 1024 * 1024;
  const MAX_LINES = 3000, MAX_ROWS = 200, MAX_COLS = 40, MAX_BLOCKS = 600;

  /** What kind of preview an attachment gets, or null (images and PDFs have their own viewers). */
  function kind(attachment) {
    if (!attachment?.uri) return null;
    const name = String(attachment.name || ''), mime = attachment.mime || '';
    if (/\.(csv|tsv)$/i.test(name)) return 'table';
    if (/\.docx$/i.test(name)) return 'docx';
    if (/\.xlsx$/i.test(name)) return 'xlsx';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    return TEXT_EXT.test(name) ? 'text' : null;
  }

  const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text != null) node.textContent = text; return node; };
  const extension = (name) => (/\.([a-z0-9]+)$/i.exec(name || '')?.[1] || '').slice(0, 4).toUpperCase();
  const plural = (n, word) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
  const clock = (seconds) => {
    if (!Number.isFinite(seconds)) return '';
    const s = Math.round(seconds), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
  };

  // ---------- reading ----------
  async function readBytes(uri, limit) {
    const response = await fetch(uri);
    if (!response.ok) throw new Error(`Could not read the file (${response.status})`);
    const reader = response.body.getReader(), chunks = [];
    let total = 0, truncated = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); total += value.length;
      if (total > limit) { truncated = true; reader.cancel().catch(() => {}); break; }
    }
    const bytes = new Uint8Array(Math.min(total, limit));
    let at = 0;
    for (const chunk of chunks) { const part = chunk.subarray(0, Math.max(0, bytes.length - at)); bytes.set(part, at); at += part.length; }
    return { bytes, truncated };
  }
  function decode(bytes, truncated) {
    const label = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
    const text = new TextDecoder(label).decode(bytes).replace(/^﻿/, '');
    if (text.includes('\u0000')) throw new Error('This file is not text');
    return truncated ? text.replace(/�$/, '') : text; // a cut multi-byte character at the end is not an error
  }
  const textCache = new Map();
  function readText(uri, limit) {
    const key = `${limit}:${uri}`;
    if (!textCache.has(key)) {
      textCache.set(key, readBytes(uri, limit).then(({ bytes, truncated }) => ({ text: decode(bytes, truncated), truncated })));
      textCache.get(key).catch(() => textCache.delete(key));
      if (textCache.size > 24) textCache.delete(textCache.keys().next().value);
    }
    return textCache.get(key);
  }
  const lineCount = (text) => (text ? text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').length : 0);

  // ---------- CSV / TSV ----------
  function delimiterFor(name, text) {
    if (/\.tsv$/i.test(name)) return '\t';
    const first = text.slice(0, text.search(/\r|\n|$/));
    const count = (c) => first.split(c).length - 1;
    return count(';') > count(',') && count(';') >= count('\t') ? ';' : count('\t') > count(',') ? '\t' : ',';
  }
  /** Quoted fields, doubled quotes and embedded newlines; stops after `maxRows` rows. */
  function parseDelimited(text, delimiter, maxRows) {
    const rows = []; let row = [], field = '', quoted = false;
    const endField = () => { row.push(field); field = ''; };
    const endRow = () => { endField(); rows.push(row); row = []; };
    for (let i = 0; i < text.length && rows.length < maxRows; i++) {
      const c = text[i];
      if (quoted) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += c; }
      else if (c === '"' && field === '') quoted = true;
      else if (c === delimiter) endField();
      else if (c === '\n') endRow();
      else if (c === '\r') { if (text[i + 1] === '\n') i++; endRow(); }
      else field += c;
    }
    if (rows.length < maxRows && (field !== '' || row.length)) endRow();
    return rows;
  }
  const columnName = (n) => { let s = ''; for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

  function renderTable(rows, { header = true, letters = false } = {}) {
    const cols = Math.min(MAX_COLS, Math.max(1, ...rows.map(r => r.length)));
    const table = el('table', 'doc-table');
    const start = header && !letters ? 1 : 0; // the first CSV row is the header; a sheet gets A, B, C instead
    if (letters || header) {
      const tr = el('tr'), head = el('thead');
      tr.append(el('th', 'doc-row-no', ''));
      const source = letters ? Array.from({ length: cols }, (_, c) => columnName(c)) : rows[0] || [];
      for (let c = 0; c < cols; c++) tr.append(el('th', letters ? 'doc-col-letter' : '', source[c] ?? ''));
      head.append(tr); table.append(head);
    }
    const body = el('tbody');
    rows.slice(start, start + MAX_ROWS).forEach((row, i) => {
      const tr = el('tr'); tr.append(el('td', 'doc-row-no', String(i + 1)));
      for (let c = 0; c < cols; c++) tr.append(el('td', /^-?[\d.,]+%?$/.test(row[c] ?? '') ? 'is-number' : '', row[c] ?? ''));
      body.append(tr);
    });
    table.append(body);
    const wrap = el('div', 'doc-table-wrap'); wrap.append(table);
    return wrap;
  }

  // ---------- viewer frame ----------
  function frame(name, info) {
    const root = el('div', 'doc-preview'), head = el('div', 'doc-preview-head');
    const badge = el('span', 'doc-preview-ext', extension(name));
    const title = el('span', 'doc-preview-title', name), meta = el('span', 'doc-preview-info', info || '');
    head.append(badge, title, meta);
    const body = el('div', 'doc-preview-body'), note = el('div', 'doc-preview-note'); note.hidden = true;
    body.setAttribute('role', 'region'); body.setAttribute('aria-label', `Preview of ${name}`); body.tabIndex = 0;
    root.append(head, body, note);
    return { root, body, meta, note, status: (text) => { body.replaceChildren(el('div', 'doc-preview-status', text)); } };
  }

  function textViewer(attachment, name, fmt) {
    const view = frame(name, fmt(attachment.size)); view.status('Loading…');
    let disposed = false;
    readText(attachment.uri, TEXT_LIMIT).then(({ text, truncated }) => {
      if (disposed) return;
      const lines = text.replace(/\r\n?/g, '\n').split('\n'); if (lines.at(-1) === '') lines.pop();
      const shown = lines.slice(0, MAX_LINES), code = el('pre', 'doc-code');
      const fragment = document.createDocumentFragment();
      for (const line of shown) fragment.append(el('span', 'doc-line', line || ' '));
      code.append(fragment);
      view.body.replaceChildren(code);
      view.meta.textContent = `${truncated || lines.length > shown.length ? `${plural(shown.length, 'line')}+` : plural(lines.length, 'line')} · ${fmt(attachment.size)}`;
      if (truncated || lines.length > shown.length) { view.note.hidden = false; view.note.textContent = `Showing the first ${lines.length > shown.length ? plural(shown.length, 'line') : fmt(TEXT_LIMIT)} of ${fmt(attachment.size)}. Open the file for the rest.`; }
    }).catch((error) => { if (!disposed) view.status(error.message || 'Preview unavailable'); });
    return { element: view.root, dispose: () => { disposed = true; } };
  }

  function tableViewer(attachment, name, fmt) {
    const view = frame(name, fmt(attachment.size)); view.status('Loading…');
    let disposed = false;
    readText(attachment.uri, TEXT_LIMIT).then(({ text, truncated }) => {
      if (disposed) return;
      const rows = parseDelimited(text, delimiterFor(name, text), MAX_ROWS + 2);
      if (!rows.length) return view.status('This table is empty');
      const more = truncated || rows.length > MAX_ROWS + 1;
      view.body.replaceChildren(renderTable(rows));
      const shown = Math.min(rows.length - 1, MAX_ROWS), cols = Math.max(...rows.map(r => r.length));
      view.meta.textContent = `${plural(cols, 'column')} · ${more ? `${shown}+` : shown} ${shown === 1 && !more ? 'row' : 'rows'} · ${fmt(attachment.size)}`;
      if (more) { view.note.hidden = false; view.note.textContent = `Showing the first ${plural(shown, 'row')}${cols > MAX_COLS ? ` and ${MAX_COLS} columns` : ''}. Open the file for the rest.`; }
    }).catch((error) => { if (!disposed) view.status(error.message || 'Preview unavailable'); });
    return { element: view.root, dispose: () => { disposed = true; } };
  }

  // ---------- Word and Excel (a small zip reader; no dependencies) ----------
  async function inflate(raw, limit) {
    const reader = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader(), chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) { reader.cancel().catch(() => {}); throw new Error('This part of the file is too large to preview'); }
      chunks.push(value);
    }
    const out = new Uint8Array(total); let at = 0;
    for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
    return out;
  }
  function openZip(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), names = new TextDecoder();
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
    if (end < 0) throw new Error('This is not a readable Office file');
    const count = view.getUint16(end + 10, true), entries = new Map();
    let p = view.getUint32(end + 16, true);
    for (let n = 0; n < count && p + 46 <= bytes.length && view.getUint32(p, true) === 0x02014b50; n++) {
      const nameLength = view.getUint16(p + 28, true);
      entries.set(names.decode(bytes.subarray(p + 46, p + 46 + nameLength)), { method: view.getUint16(p + 10, true), size: view.getUint32(p + 20, true), offset: view.getUint32(p + 42, true) });
      p += 46 + nameLength + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
    }
    return {
      has: (name) => entries.has(name),
      async text(name) {
        const entry = entries.get(name);
        if (!entry) return null;
        const start = entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true);
        const raw = bytes.subarray(start, start + entry.size);
        if (entry.method !== 0 && entry.method !== 8) throw new Error('This file uses an unsupported compression');
        const data = entry.method === 0 ? raw : await inflate(raw, PART_LIMIT);
        if (data.length > PART_LIMIT) throw new Error('This part of the file is too large to preview');
        return new TextDecoder().decode(data);
      },
    };
  }
  const xml = (text) => {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('This file could not be read');
    return doc;
  };
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const kids = (node, ns, tag) => [...node.children].filter(c => c.localName === tag && c.namespaceURI === ns);
  const first = (node, ns, tag) => kids(node, ns, tag)[0] || null;
  const flag = (node) => node && !/^(0|false|none)$/i.test(node.getAttributeNS(W, 'val') || 'true');

  function docxParagraph(p) {
    const properties = first(p, W, 'pPr'), style = first(properties || p, W, 'pStyle')?.getAttributeNS(W, 'val') || '';
    const level = /^Title$/i.test(style) ? 1 : Number(/^Heading\s?([1-6])/i.exec(style)?.[1]) || 0;
    const block = el(level ? `h${Math.min(level + 1, 6)}` : 'p', level ? 'doc-docx-heading' : '');
    if (properties && first(properties, W, 'numPr')) { block.classList.add('doc-docx-item'); }
    for (const run of p.getElementsByTagNameNS(W, 'r')) {
      let text = '';
      for (const part of run.children) {
        if (part.localName === 't') text += part.textContent; else if (part.localName === 'tab') text += '\t'; else if (part.localName === 'br' || part.localName === 'cr') text += '\n';
      }
      if (!text) continue;
      const format = first(run, W, 'rPr'), span = el('span', '', text);
      if (flag(format && first(format, W, 'b'))) span.style.fontWeight = '650';
      if (flag(format && first(format, W, 'i'))) span.style.fontStyle = 'italic';
      if (format && first(format, W, 'u') && first(format, W, 'u').getAttributeNS(W, 'val') !== 'none') span.style.textDecoration = 'underline';
      block.append(span);
    }
    return block.textContent.trim() ? block : null;
  }
  function docxBlocks(source) {
    const body = xml(source).getElementsByTagNameNS(W, 'body')[0], out = [];
    if (!body) throw new Error('This Word file has no text');
    for (const node of body.children) {
      if (out.length >= MAX_BLOCKS) break;
      if (node.localName === 'p') { const block = docxParagraph(node); if (block) out.push(block); }
      else if (node.localName === 'tbl') {
        const rows = kids(node, W, 'tr').map(tr => kids(tr, W, 'tc').map(tc => kids(tc, W, 'p').map(p => p.textContent).filter(Boolean).join('\n')));
        if (rows.length) out.push(renderTable(rows, { header: false }));
      }
    }
    return out;
  }
  async function officeFile(attachment) {
    const { bytes, truncated } = await readBytes(attachment.uri, OFFICE_LIMIT);
    if (truncated) throw new Error(`This file is larger than ${Math.round(OFFICE_LIMIT / 1048576)} MB; open it in its own app`);
    return openZip(bytes);
  }

  function docxViewer(attachment, name, fmt) {
    const view = frame(name, fmt(attachment.size)); view.status('Loading…');
    let disposed = false;
    (async () => {
      const zip = await officeFile(attachment), source = await zip.text('word/document.xml');
      if (!source) throw new Error('This is not a Word document');
      const blocks = docxBlocks(source);
      if (disposed) return;
      if (!blocks.length) return view.status('This document has no text');
      const page = el('div', 'doc-docx'); page.append(...blocks);
      view.body.replaceChildren(page);
      view.meta.textContent = `Word document · ${fmt(attachment.size)}`;
      view.note.hidden = false; view.note.textContent = 'Text only: images, headers and layout are not drawn here. The agent reads the original file.';
    })().catch((error) => { if (!disposed) view.status(error.message || 'Preview unavailable'); });
    return { element: view.root, dispose: () => { disposed = true; } };
  }

  function sheetRows(source, shared) {
    const rows = [];
    for (const row of xml(source).getElementsByTagNameNS(S, 'row')) {
      if (rows.length >= MAX_ROWS) break;
      const cells = [];
      for (const cell of kids(row, S, 'c')) {
        const ref = /^([A-Z]+)/.exec(cell.getAttribute('r') || '')?.[1];
        const index = ref ? [...ref].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1 : cells.length;
        if (index >= MAX_COLS) continue;
        if (index >= MAX_COLS) continue;
        const type = cell.getAttribute('t'), raw = first(cell, S, 'v')?.textContent ?? '';
        let value = raw;
        if (type === 's') value = shared[Number(raw)] ?? '';
        else if (type === 'inlineStr') value = [...cell.getElementsByTagNameNS(S, 't')].map(t => t.textContent).join('');
        else if (type === 'b') value = raw === '1' ? 'TRUE' : 'FALSE';
        else if (!type || type === 'n') value = raw !== '' && Number.isFinite(Number(raw)) ? String(+Number(raw).toPrecision(12)) : raw;
        cells[index] = value;
      }
      rows.push(Array.from(cells, v => v ?? ''));
    }
    return rows;
  }
  function xlsxViewer(attachment, name, fmt) {
    const view = frame(name, fmt(attachment.size)); view.status('Loading…');
    let disposed = false;
    (async () => {
      const zip = await officeFile(attachment), book = await zip.text('xl/workbook.xml');
      if (!book) throw new Error('This is not an Excel workbook');
      const rels = new Map(); const relSource = await zip.text('xl/_rels/workbook.xml.rels');
      if (relSource) for (const rel of xml(relSource).getElementsByTagName('Relationship')) rels.set(rel.getAttribute('Id'), rel.getAttribute('Target'));
      const sheets = [...xml(book).getElementsByTagNameNS(S, 'sheet')].map((sheet, i) => {
        const target = rels.get(sheet.getAttributeNS(R, 'id')) || `worksheets/sheet${i + 1}.xml`;
        return { name: sheet.getAttribute('name') || `Sheet ${i + 1}`, part: target.startsWith('/') ? target.slice(1) : `xl/${target}` };
      });
      const stringsSource = await zip.text('xl/sharedStrings.xml'), shared = [];
      if (stringsSource) for (const si of xml(stringsSource).getElementsByTagNameNS(S, 'si')) shared.push([...si.getElementsByTagNameNS(S, 't')].filter(t => t.parentNode.localName !== 'rPh').map(t => t.textContent).join(''));
      if (!sheets.length) throw new Error('This workbook has no sheets');
      if (disposed) return;
      const tabs = el('div', 'doc-sheet-tabs'); tabs.setAttribute('role', 'tablist');
      const pane = el('div', 'doc-sheet-pane');
      let current = -1;
      const show = async (index) => {
        current = index;
        [...tabs.children].forEach((tab, i) => { tab.setAttribute('aria-selected', String(i === index)); tab.tabIndex = i === index ? 0 : -1; });
        pane.replaceChildren(el('div', 'doc-preview-status', 'Loading…'));
        try {
          const source = await zip.text(sheets[index].part);
          if (disposed || current !== index) return;
          const rows = source ? sheetRows(source, shared) : [];
          if (!rows.length) pane.replaceChildren(el('div', 'doc-preview-status', 'This sheet is empty'));
          else pane.replaceChildren(renderTable(rows, { letters: true }));
          view.note.hidden = rows.length < MAX_ROWS; view.note.textContent = `Showing the first ${MAX_ROWS} rows. Values only: formulas, formats and dates are shown as stored.`;
        } catch (error) { if (!disposed && current === index) pane.replaceChildren(el('div', 'doc-preview-status', error.message || 'Preview unavailable')); }
      };
      sheets.forEach((sheet, i) => { const tab = el('button', 'doc-sheet-tab', sheet.name); tab.type = 'button'; tab.setAttribute('role', 'tab'); tab.addEventListener('click', (event) => { event.stopPropagation(); void show(i); }); tabs.append(tab); });
      view.body.replaceChildren(pane); view.body.before(tabs);
      view.meta.textContent = `${plural(sheets.length, 'sheet')} · ${fmt(attachment.size)}`;
      await show(0);
    })().catch((error) => { if (!disposed) view.status(error.message || 'Preview unavailable'); });
    return { element: view.root, dispose: () => { disposed = true; } };
  }

  // ---------- audio and video ----------
  const mediaInfo = new Map();
  /** Duration, and for video one still frame, read from the file's metadata without playing it. */
  function inspectMedia(attachment, video) {
    if (!mediaInfo.has(attachment.uri)) {
      const result = new Promise((resolve, reject) => {
        const media = document.createElement(video ? 'video' : 'audio');
        media.muted = true; media.preload = 'metadata'; media.playsInline = true;
        const timer = setTimeout(() => done(new Error('timeout')), 8000);
        const done = (error, value) => { clearTimeout(timer); media.removeAttribute('src'); media.load(); error ? reject(error) : resolve(value); };
        media.addEventListener('error', () => done(new Error('Could not decode this file')), { once: true });
        media.addEventListener('loadedmetadata', () => {
          const duration = media.duration;
          if (!video) return done(null, { duration });
          media.addEventListener('seeked', () => {
            try {
              const scale = 96 / Math.max(media.videoWidth, media.videoHeight, 1), canvas = document.createElement('canvas');
              canvas.width = Math.max(1, Math.round(media.videoWidth * scale)); canvas.height = Math.max(1, Math.round(media.videoHeight * scale));
              canvas.getContext('2d').drawImage(media, 0, 0, canvas.width, canvas.height);
              done(null, { duration, frame: canvas.toDataURL('image/jpeg', 0.72), width: media.videoWidth, height: media.videoHeight });
            } catch { done(null, { duration }); }
          }, { once: true });
          media.currentTime = Number.isFinite(duration) && duration > 0 ? Math.min(0.5, duration / 4) : 0;
        }, { once: true });
        media.src = attachment.uri;
      });
      mediaInfo.set(attachment.uri, result);
      result.catch(() => mediaInfo.delete(attachment.uri));
      if (mediaInfo.size > 32) mediaInfo.delete(mediaInfo.keys().next().value);
    }
    return mediaInfo.get(attachment.uri);
  }

  const EQUALIZER = [0.4, 0.75, 0.5, 1, 0.6, 0.85, 0.35];
  function mediaViewer(attachment, name, fmt, isVideo) {
    const view = frame(name, fmt(attachment.size));
    const media = document.createElement(isVideo ? 'video' : 'audio');
    media.controls = true; media.preload = 'metadata'; media.setAttribute('aria-label', name);
    if (isVideo) { media.playsInline = true; media.className = 'doc-video'; }
    media.addEventListener('click', (event) => event.stopPropagation());
    let stage = media;
    if (isVideo) view.body.append(media);
    else {
      stage = el('div', 'doc-audio');
      const bars = el('div', 'doc-audio-bars'); bars.setAttribute('aria-hidden', 'true');
      for (const h of EQUALIZER) bars.append(Object.assign(el('i'), { style: `--h:${h}` }));
      media.className = 'doc-audio-player';
      stage.append(bars, media); view.body.append(stage);
      media.addEventListener('play', () => stage.classList.add('is-playing'));
      for (const type of ['pause', 'ended']) media.addEventListener(type, () => stage.classList.remove('is-playing'));
    }
    media.addEventListener('error', () => { view.note.hidden = false; view.note.textContent = 'This codec cannot be played here. Open the file in an external player; the agent still reads the original.'; });
    media.addEventListener('loadedmetadata', () => { view.meta.textContent = `${isVideo && media.videoWidth ? `${media.videoWidth}×${media.videoHeight} · ` : ''}${clock(media.duration)} · ${fmt(attachment.size)}`; });
    media.src = attachment.uri;
    return { element: view.root, dispose: () => { media.pause(); media.removeAttribute('src'); media.load(); } };
  }

  function viewer(attachment, name, fmt) {
    switch (kind(attachment)) {
      case 'text': return textViewer(attachment, name, fmt);
      case 'table': return tableViewer(attachment, name, fmt);
      case 'docx': return docxViewer(attachment, name, fmt);
      case 'xlsx': return xlsxViewer(attachment, name, fmt);
      case 'video': return mediaViewer(attachment, name, fmt, true);
      case 'audio': return mediaViewer(attachment, name, fmt, false);
      default: return null;
    }
  }

  // ---------- chip thumbnail ----------
  /** The small tile on a chip, plus a promise for the chip's second line once the file has been read. */
  function thumbnail(attachment, fmt) {
    const type = kind(attachment), tile = el('span', `attachment-doc is-${type}`);
    tile.setAttribute('aria-hidden', 'true');
    const label = el('b', 'attachment-doc-ext', extension(attachment.name) || type.slice(0, 3).toUpperCase());
    const lines = (widths) => widths.forEach(w => tile.append(Object.assign(el('i'), { style: `width:${w}%` })));
    const grid = (header) => { tile.classList.add('has-grid'); for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) tile.append(el('i', r === 0 && header ? 'is-head' : '')); };
    let ready = Promise.resolve(null);
    if (type === 'text') {
      lines([70, 90, 55, 80, 40]);
      ready = readText(attachment.uri, THUMB_LIMIT).then(({ text, truncated }) => {
        const sample = text.replace(/\r\n?/g, '\n').split('\n').filter(l => l.trim()).slice(0, 5);
        tile.replaceChildren(...sample.map(l => Object.assign(el('i'), { style: `width:${Math.max(18, Math.min(100, Math.round(l.trim().length * 2.2)))}%` })), label);
        const n = lineCount(text);
        return `${truncated ? `${n}+` : n} ${n === 1 && !truncated ? 'line' : 'lines'} · ${fmt(attachment.size)}`;
      });
    } else if (type === 'table') {
      grid(true);
      ready = readText(attachment.uri, THUMB_LIMIT).then(({ text, truncated }) => {
        const rows = parseDelimited(text, delimiterFor(attachment.name, text), 400), cols = Math.max(0, ...rows.map(r => r.length));
        return `${plural(cols, 'column')} · ${rows.length}${truncated ? '+' : ''} rows`;
      });
    } else if (type === 'docx') { lines([85, 60, 90, 70]); }
    else if (type === 'xlsx') { grid(true); }
    else if (type === 'audio') {
      tile.classList.add('has-bars'); for (const h of EQUALIZER) tile.append(Object.assign(el('i'), { style: `--h:${h}` }));
      ready = inspectMedia(attachment, false).then(({ duration }) => `${clock(duration)} · ${fmt(attachment.size)}`);
    } else if (type === 'video') {
      tile.classList.add('has-frame');
      ready = inspectMedia(attachment, true).then(({ duration, frame: still }) => {
        if (still) tile.style.backgroundImage = `url("${still}")`;
        tile.append(el('u'));
        return `${clock(duration)} · ${fmt(attachment.size)}`;
      });
    }
    tile.append(label);
    return { element: tile, ready: ready.catch(() => `${fmt(attachment.size)} · Preview unavailable`) };
  }

  window.attachmentDocs = { kind, viewer, thumbnail, parseDelimited, delimiterFor, openZip, docxBlocks, sheetRows };
})();
