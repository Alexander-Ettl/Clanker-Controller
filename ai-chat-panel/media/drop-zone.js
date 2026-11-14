// Tracks a file drag hovering the window. The IDE decides who receives a drag (Shift hands it to the webview),
// so dragleave/dragend/drop do not always arrive: releasing Shift mid-drag, Esc, or a drop that lands on the IDE's
// own overlay all end the drag without telling us. A dragover keep-alive and the "any ordinary input means the
// drag is over" events below are what end it then. Pure DOM wiring, shared by main.js and the tests.
(function (root) {
  'use strict';
  const QUIET_MS = 800; // dragover repeats every 50-350ms while a drag hovers; silence this long means it is gone

  function isAttachmentDrag(event) {
    const types = event.dataTransfer && event.dataTransfer.types;
    return !!types && [...types].some((type) => type === 'Files' || /uri-list|^(?:resourceurls|codeeditors|codefiles)$/i.test(type));
  }

  // Every file the IDE put on a drag. A multi-selection in the Explorer is not always in the one list the old code read:
  // the URI list, the IDE's JSON resource lists and the plain-text path list each carry it, so all are read and merged.
  function droppedUris(dataTransfer) {
    if (!dataTransfer) return [];
    const get = (type) => { try { return dataTransfer.getData(type) || ''; } catch { return ''; } };
    const found = new Set();
    const add = (value) => {
      if (typeof value !== 'string') return;
      const text = value.trim();
      if (/^file:/i.test(text)) found.add(text);
    };
    for (const type of ['application/vnd.code.uri-list', 'text/uri-list']) for (const line of get(type).split(/\r?\n/)) add(line);
    for (const type of ['ResourceURLs', 'resourceurls']) {
      try { for (const item of JSON.parse(get(type) || '[]')) add(typeof item === 'string' ? item : item && item.resource); } catch { /* not JSON */ }
    }
    try { for (const item of JSON.parse(get('CodeEditors') || '[]')) add(item && (typeof item.resource === 'string' ? item.resource : item.resource && item.resource.external)); } catch { /* not JSON */ }
    if (!found.size && !(dataTransfer.files && dataTransfer.files.length)) { // last resort: the IDE's text/plain form is one absolute path per line
      for (const line of get('text/plain').split(/\r?\n/).map((entry) => entry.trim())) {
        if (/^(?:[a-z]:[\\/]|\\\\|\/)[^\n]+$/i.test(line)) found.add(`file:///${encodeURI(line.replace(/\\/g, '/')).replace(/^\/+/, '')}`);
      }
    }
    return [...found];
  }

  function createDropZone({ doc, win, setActive, onDrop, schedule = setTimeout, cancel = clearTimeout }) {
    let timer = null;
    let active = false;
    const end = () => {
      if (timer !== null) { cancel(timer); timer = null; }
      if (active) { active = false; setActive(false); }
    };
    const keepAlive = () => {
      if (timer !== null) cancel(timer);
      timer = schedule(end, QUIET_MS);
      if (!active) { active = true; setActive(true); }
    };
    const leftWindow = (event) => event.clientX <= 0 || event.clientY <= 0 || event.clientX >= win.innerWidth || event.clientY >= win.innerHeight;

    doc.addEventListener('dragenter', (event) => { if (isAttachmentDrag(event)) keepAlive(); });
    doc.addEventListener('dragover', (event) => {
      if (!isAttachmentDrag(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      keepAlive();
    });
    doc.addEventListener('dragleave', (event) => { if (leftWindow(event)) end(); });
    doc.addEventListener('drop', (event) => {
      if (!isAttachmentDrag(event)) return;
      event.preventDefault();
      end();
      onDrop(event);
    });
    for (const name of ['dragend', 'pointermove', 'pointerdown']) doc.addEventListener(name, end, true);
    doc.addEventListener('keydown', (event) => { if (event.key === 'Escape') end(); }, true);
    win.addEventListener('blur', end);
    doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'hidden') end(); });
    return { end, isActive: () => active };
  }

  const api = { createDropZone, isAttachmentDrag, droppedUris, QUIET_MS };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.dropZone = api;
})(typeof window === 'object' ? window : globalThis);
