/* What a right-click should copy. Given the element under the pointer (and any selected text it landed on), returns the
   entries for the context menu, most specific first: selection, file, link, code, table, text block, whole message.
   Entries are plain data: { kind: 'copy' | 'copyPath' | 'copyFile' | 'openFile' | 'openUrl' | 'download', label, ... }. */
(() => {
  'use strict';
  const MAX_TEXT = 200000;
  const clean = (text) => String(text ?? '').replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n').slice(0, MAX_TEXT);
  const tidy = (text) => clean(text).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  /** Rows of cell text to tab-separated lines, which paste into a spreadsheet as a grid. */
  function toTsv(rows) {
    return rows.map((row) => row.map((cell) => String(cell).replace(/[\t\r\n]+/g, ' ').trim()).join('\t')).join('\n');
  }

  function tableRows(table) {
    return [...table.querySelectorAll('tr')].map((tr) => [...tr.children].map((cell) => cell.textContent));
  }

  const BLOCKS = [
    ['h1, h2, h3, h4, h5, h6', 'Copy heading'],
    ['li', 'Copy item'],
    ['blockquote', 'Copy quote'],
    ['p', 'Copy paragraph'],
  ];

  function targetsAt(el, { selection = '' } = {}) {
    if (!el?.closest) return [];
    if (el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return []; // typing fields keep the native menu
    const out = [];
    const add = (entry) => {
      if (!entry || (entry.text !== undefined && !String(entry.text).trim())) return;
      if (!out.some((other) => other.kind === entry.kind && other.label === entry.label && other.text === entry.text)) out.push(entry);
    };
    const copy = (label, text, noun) => add({ kind: 'copy', label, text: clean(text), noun: noun || label.replace(/^Copy /, '') });

    if (selection.trim()) add({ kind: 'copy', label: 'Copy', text: clean(selection), noun: 'text', hint: 'Ctrl+C' });

    const badge = el.closest('.file-badge');
    if (badge?.dataset.path) {
      const file = badge.dataset.path;
      const line = Number(badge.dataset.line) || null;
      add({ kind: 'openFile', label: 'Open', path: file, line });
      add({ kind: 'copyPath', label: 'Copy path', path: file });
      add({ kind: 'copyFile', label: 'Copy file', path: file });
      add({ kind: 'copy', label: 'Copy name', text: file.split(/[\\/]/).pop(), noun: 'file name' });
    }

    const chip = el.closest('.attachment-chip');
    if (chip?._attachment && !chip.querySelector('img:not([hidden])')) { // images and PDFs have their own menu or open directly
      const name = chip.querySelector('.attachment-name')?.textContent || '';
      add({ kind: 'copy', label: 'Copy name', text: name, noun: 'file name' });
      add({ kind: 'download', label: 'Download', attachment: chip._attachment });
    }

    const link = el.closest('a[href]');
    const href = link?.getAttribute('href') || '';
    if (/^(https?:|mailto:)/i.test(href)) {
      const mail = /^mailto:/i.test(href);
      add({ kind: 'copy', label: mail ? 'Copy email address' : 'Copy link', text: mail ? href.replace(/^mailto:/i, '') : href, noun: mail ? 'email address' : 'link' });
      if (!mail) add({ kind: 'openUrl', label: 'Open link', url: href });
      if (link.textContent.trim() && link.textContent.trim() !== href) add({ kind: 'copy', label: 'Copy link text', text: link.textContent, noun: 'link text' });
    }

    const specific = out.length > (selection.trim() ? 1 : 0); // a file or link was hit: its own entries are the point
    const block = el.closest('.code-block');
    const pre = el.closest('pre');
    let precise = specific || Boolean(selection.trim()); // a selection already says which text
    if (block || pre) {
      const code = (block?.querySelector('pre') || pre).textContent.replace(/\n$/, '');
      const inTool = !block && pre.closest('.tool-card, .approval-card');
      copy(inTool ? 'Copy output' : 'Copy code', code, inTool ? 'output' : 'code');
      precise = true;
    } else {
      const inline = el.closest('code');
      if (inline) { copy('Copy code', inline.textContent, 'code'); precise = true; }
    }

    const table = el.closest('table');
    if (table) {
      const cell = el.closest('td, th');
      if (cell) copy('Copy cell', cell.textContent.trim(), 'cell');
      add({ kind: 'copy', label: 'Copy table', text: toTsv(tableRows(table)), noun: 'table' });
      precise = true;
    } else if (!precise) {
      for (const [selector, label] of BLOCKS) {
        const found = el.closest(selector);
        if (found && el.closest('.msg-body, .msg-user-text')) { copy(label, tidy(found.textContent), label.replace(/^Copy /, '')); break; }
      }
    }

    const message = el.closest('.msg');
    if (message && !specific) {
      const raw = message.dataset.raw || message.querySelector('.msg-body, .msg-user-text')?.innerText || '';
      const last = out[out.length - 1];
      if (last && last.kind === 'copy' && BLOCKS.some(([, label]) => label === last.label) && tidy(last.text) === tidy(raw)) last.label = 'Copy message'; // the block is the message
      else copy('Copy message', tidy(raw), 'message');
    }

    if (!out.length) { // tool cards, thoughts, approvals, notices: their visible text
      const card = el.closest('.tool-card, .thought-fold, .approval-card, .question-card, .notice, .toast');
      if (card) copy('Copy', tidy(card.innerText ?? card.textContent), 'text');
    }
    return out;
  }

  const api = { targetsAt, toTsv };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else window.copyTargets = api;
})();
