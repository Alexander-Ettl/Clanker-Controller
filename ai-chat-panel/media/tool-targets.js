/* What a tool card in the transcript can show or open, so you can follow what the agent looks at without hunting for it.
   A card's command or a result line resolves to a target: { type: 'image' | 'file' | 'url', value, line? }.
   image: a picture the agent viewed (opens the preview); file: a source file (opens in the editor at the line);
   url: a web page (opens in the browser). Pure functions, no DOM, so they are unit-tested. */
(() => {
  'use strict';
  const IMAGE = /\.(?:png|jpe?g|gif|webp|bmp|avif|svg|ico)$/i;
  const PATH_START = /^(?:[a-zA-Z]:[\\/]|[\\/]|\.\.?[\\/]|[\w.-]+[\\/])/;
  const MAX_RESULT_LINES = 400;

  /** A bare file path in a command ("C:\\Dev\\shot.png", "src/app.js"); null for anything with spaces around or in it. */
  function pathIn(command) {
    const text = String(command || '').trim().replace(/^["']|["']$/g, '');
    if (!text || text.includes('\n') || /^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return null;
    if (/^[^\s"]+$/.test(text) || PATH_START.test(text)) return text.length < 520 ? text : null;
    return null;
  }

  /** The target of a whole card, from its command. `kind` is the card's kind (read, edit, search, web, ...). */
  function cardTarget(kind, command) {
    const text = String(command || '').trim();
    const url = text.match(/^https?:\/\/[^\s"']+/i);
    if (url && (kind === 'web' || kind === 'other' || kind === 'read' || text === url[0])) return { type: 'url', value: url[0] };
    const file = pathIn(text);
    if (!file) return null;
    if (IMAGE.test(file)) return { type: 'image', value: file };
    // Only a read or an edit is known to name a file; a path inside another tool's command is left alone.
    if ((kind === 'read' || kind === 'edit') && /[\\/]|\.[A-Za-z0-9]{1,8}$/.test(file)) return { type: 'file', value: file };
    return null;
  }

  /** One line of a Grep or Glob result: "path", "path:12:text" or "C:\\x\\path:12:text". */
  function lineTarget(line) {
    const match = String(line || '').match(/^((?:[a-zA-Z]:)?[^\s:*?"<>|]+\.[A-Za-z0-9]{1,8})(?::(\d+))?(?::|$)/);
    if (!match) return null;
    return IMAGE.test(match[1]) ? { type: 'image', value: match[1] } : { type: 'file', value: match[1], line: match[2] ? Number(match[2]) : undefined };
  }

  /** Targets for every line of a result (null where a line names nothing), capped so a huge listing stays cheap. */
  function resultTargets(text) {
    return String(text || '').split('\n').slice(0, MAX_RESULT_LINES).map(lineTarget);
  }

  const api = { cardTarget, lineTarget, resultTargets, MAX_RESULT_LINES };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else window.toolTargets = api;
})();
