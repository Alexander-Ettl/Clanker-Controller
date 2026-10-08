/* PDF.js 6.4.299 is bundled locally: previews never upload documents. */
(() => {
  const base = new URL('vendor/pdfjs/', document.currentScript.src).href;
  let library;
  const thumbnails = new Map();
  async function load(uri) {
    library ||= import(`${base}pdf.min.mjs`).then(pdfjs => {
      pdfjs.GlobalWorkerOptions.workerSrc = `${base}pdf.worker.min.mjs`;
      return pdfjs;
    });
    const pdfjs = await library;
    return pdfjs.getDocument({ url: uri, cMapUrl: `${base}cmaps/`, cMapPacked: true,
      standardFontDataUrl: `${base}standard_fonts/`, wasmUrl: `${base}wasm/`, isEvalSupported: false });
  }
  async function render(pdf, number, width) {
    const page = await pdf.getPage(number);
    const viewport = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    page.cleanup();
    return canvas;
  }
  function thumbnail(uri) {
    if (!thumbnails.has(uri)) {
      const result = (async () => {
        const task = await load(uri);
        try {
          const pdf = await task.promise;
          return { uri: (await render(pdf, 1, 120)).toDataURL(), pages: pdf.numPages };
        } finally { await task.destroy(); }
      })();
      thumbnails.set(uri, result);
      result.catch(() => thumbnails.delete(uri));
      if (thumbnails.size > 32) thumbnails.delete(thumbnails.keys().next().value);
    }
    return thumbnails.get(uri);
  }
  function viewer(uri, name) {
    const element = document.createElement('div'); element.className = 'pdf-preview';
    const content = document.createElement('div'); content.className = 'pdf-preview-page';
    const status = document.createElement('span'); status.setAttribute('role', 'status'); status.textContent = 'Loading PDF…';
    const controls = document.createElement('div'); controls.className = 'pdf-preview-controls';
    const previous = document.createElement('button'); previous.type = 'button'; previous.textContent = '‹'; previous.setAttribute('aria-label', 'Previous page');
    const next = document.createElement('button'); next.type = 'button'; next.textContent = '›'; next.setAttribute('aria-label', 'Next page');
    controls.append(previous, status, next); element.append(content, controls);
    let pdf, task, number = 1, disposed = false, busy = false;
    const buttons = () => { previous.disabled = busy || !pdf || number === 1; next.disabled = busy || !pdf || number === pdf.numPages; };
    const draw = async () => {
      busy = true; buttons();
      try {
        const width = Math.min(1000, Math.max(240, window.innerWidth - 80)) * Math.min(window.devicePixelRatio || 1, 2);
        const canvas = await render(pdf, number, width);
        canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', `${name}, page ${number}`);
        if (!disposed) { content.replaceChildren(canvas); status.textContent = `Page ${number} of ${pdf.numPages}`; }
      } catch { if (!disposed) status.textContent = 'Could not render this PDF page'; }
      finally { busy = false; buttons(); }
    };
    previous.onclick = () => { if (!busy && number > 1) { number--; void draw(); } };
    next.onclick = () => { if (!busy && number < pdf.numPages) { number++; void draw(); } };
    buttons();
    void (async () => {
      try {
        task = await load(uri);
        if (disposed) { await task.destroy(); return; }
        pdf = await task.promise;
        if (!disposed) await draw();
      } catch { if (!disposed) status.textContent = 'Preview unavailable (unreadable or password-protected PDF)'; }
    })();
    return { element, dispose: () => { disposed = true; if (task) void task.destroy(); } };
  }
  window.attachmentPdf = { thumbnail, viewer };
})();
