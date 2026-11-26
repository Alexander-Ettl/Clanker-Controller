// Tracks a file drag hovering the window. The IDE decides who receives a drag (Shift hands it to the webview),
// so dragleave/dragend/drop do not always arrive: releasing Shift mid-drag, Esc, or a drop that lands on the IDE's
// own overlay all end the drag without telling us. A dragover keep-alive and the "any ordinary input means the
// drag is over" events below are what end it then. Pure DOM wiring, shared by main.js and the tests.
(function (root) {
  'use strict';
  const QUIET_MS = 800; // dragover repeats every 50-350ms while a drag hovers; silence this long means it is gone
  const IDE_DRAG_TYPES = /^(?:application\/vnd\.code\.uri-list|resourceurls|codeeditors|codefiles)$/i;
  const URI_LIST_TYPES = ['application/vnd.code.uri-list', 'text/uri-list', 'application/x-kde-urilist', 'x-special/gnome-copied-files'];

  function isIdeDrag(dataTransfer) {
    const types = dataTransfer && dataTransfer.types;
    return !!types && [...types].some((type) => IDE_DRAG_TYPES.test(type));
  }

  function isAttachmentDrag(event) {
    const dt = event.dataTransfer;
    if (!dt) return false;
    const types = dt.types;
    if (types && [...types].some((type) => type === 'Files' || /(?:uri-?list|gnome-copied-files)/i.test(type) || IDE_DRAG_TYPES.test(type))) return true;
    return !!(dt.items && [...dt.items].some((item) => item.kind === 'file'));
  }

  // Every file URI on a drag or clipboard payload. Multi-selections in Explorer, KDE Dolphin (text/uri-list,
  // application/x-kde-urilist), and GTK (x-special/gnome-copied-files) each use different types, so all are read and merged.
  function droppedUris(dataTransfer) {
    if (!dataTransfer) return [];
    const get = (type) => { try { return dataTransfer.getData(type) || ''; } catch { return ''; } };
    const found = new Set();
    const add = (value) => {
      if (typeof value !== 'string') return;
      const text = value.trim();
      if (/^file:/i.test(text)) found.add(text);
    };
    for (const type of URI_LIST_TYPES) for (const line of get(type).split(/\r?\n/)) add(line);
    for (const type of ['ResourceURLs', 'resourceurls']) {
      try { for (const item of JSON.parse(get(type) || '[]')) add(typeof item === 'string' ? item : item && item.resource); } catch { /* not JSON */ }
    }
    try { for (const item of JSON.parse(get('CodeEditors') || '[]')) add(item && (typeof item.resource === 'string' ? item.resource : item.resource && item.resource.external)); } catch { /* not JSON */ }
    if (!found.size && !(dataTransfer.files && dataTransfer.files.length)) { // last resort: one absolute path per line in text/plain
      for (const line of get('text/plain').split(/\r?\n/).map((entry) => entry.trim())) {
        if (/^(?:[a-z]:[\\/]|\\\\|\/)[^\n]+$/i.test(line)) {
          const encoded = encodeURI(line.replace(/\\/g, '/')).replace(/#/g, '%23').replace(/\?/g, '%3F').replace(/^\/+/, '');
          found.add(`file:///${encoded}`);
        }
      }
    }
    return [...found];
  }

  // Classifies a drop:
  // - IDE drags (Explorer / editor tabs) -> workspace @-mentions (`mentions`).
  // - Linux/OS file manager drags carry both `Files` and `text/uri-list`: attach real files (instead of only @-mentioning
  //   them) and let the host handle URI-only drops or drops containing folders cleanly via `uris`.
  function classifyDrop(dataTransfer) {
    if (!dataTransfer) return { kind: 'none' };
    const uris = droppedUris(dataTransfer);
    if (isIdeDrag(dataTransfer)) return uris.length ? { kind: 'mentions', uris } : { kind: 'none' };

    const items = dataTransfer.items ? [...dataTransfer.items] : [];
    const hasDirectories = items.some((item) => {
      try { return Boolean(item.webkitGetAsEntry && item.webkitGetAsEntry()?.isDirectory); } catch { return false; }
    });
    if (hasDirectories && uris.length) return { kind: 'uris', uris };

    const files = dataTransfer.files ? [...dataTransfer.files] : [];
    const realFiles = files.filter((_, index) => {
      const item = items[index];
      if (!item || !item.webkitGetAsEntry) return true;
      try { return !item.webkitGetAsEntry()?.isDirectory; } catch { return true; }
    });
    if (realFiles.length) return { kind: 'files', files: realFiles, uris };
    if (uris.length) return { kind: 'uris', uris };
    return { kind: 'none' };
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

    // Calling preventDefault + stopPropagation on document prevents VS Code's outer contentWindow dragenter/dragover
    // listeners from forwarding `drag-start` / `drag { shiftKey: false }` and locking the iframe with pointer-events: none.
    // That lets external OS file drops land directly in the webview without holding Shift (and fixes Wayland where shiftKey
    // is not propagated during external drags).
    doc.addEventListener('dragenter', (event) => {
      if (!isAttachmentDrag(event)) return;
      event.preventDefault();
      event.stopPropagation?.();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      keepAlive();
    });
    doc.addEventListener('dragover', (event) => {
      if (!isAttachmentDrag(event)) return;
      event.preventDefault();
      event.stopPropagation?.();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      keepAlive();
    });
    doc.addEventListener('dragleave', (event) => { if (leftWindow(event)) end(); });
    doc.addEventListener('drop', (event) => {
      if (!isAttachmentDrag(event)) return;
      event.preventDefault();
      event.stopPropagation?.();
      end();
      onDrop(event);
    });
    for (const name of ['dragend', 'pointermove', 'pointerdown']) doc.addEventListener(name, end, true);
    doc.addEventListener('keydown', (event) => { if (event.key === 'Escape') end(); }, true);
    win.addEventListener('blur', end);
    doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'hidden') end(); });
    return { end, isActive: () => active };
  }

  const api = { createDropZone, isAttachmentDrag, isIdeDrag, droppedUris, classifyDrop, QUIET_MS };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.dropZone = api;
})(typeof window === 'object' ? window : globalThis);
