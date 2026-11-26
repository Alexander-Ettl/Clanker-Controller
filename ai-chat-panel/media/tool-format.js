/* How a tool card's output is read before it is drawn (the drawing is in main.js). Pure functions, no DOM, so they are
   unit-tested. Each parser answers "is this output shaped like X?" and returns the pieces, or null so the card falls
   back to plain text. Shapes: line-numbered file reads, Grep matches, file lists, Web search results, ANSI-coloured
   terminal output, unified diffs, JSON. */
(() => {
  'use strict';

  // Grammars the bundled Shiki carries (media/vendor/shiki); anything else stays uncoloured instead of failing.
  const LANGS = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx', ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
    css: 'css', scss: 'scss', html: 'html', htm: 'html', astro: 'astro', json: 'json', jsonc: 'jsonc', yml: 'yaml', yaml: 'yaml',
    ps1: 'powershell', psm1: 'powershell', psd1: 'powershell', sh: 'bash', bash: 'bash', zsh: 'bash', bat: 'bat', cmd: 'bat',
    py: 'python', java: 'java', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', xml: 'xml', svg: 'xml', sql: 'sql', graphql: 'graphql',
    gql: 'graphql', lua: 'lua', rb: 'ruby', md: 'markdown', markdown: 'markdown', diff: 'diff', patch: 'diff', glsl: 'glsl',
  };
  const IMAGE = /\.(?:png|jpe?g|gif|webp|bmp|avif|svg|ico)$/i;

  /** The Shiki language for a file name or path, '' when the bundle has none. */
  function langFor(file) {
    const name = String(file || '').split(/[\\/]/).pop().toLowerCase();
    if (name === 'dockerfile' || name === 'makefile') return '';
    return LANGS[name.includes('.') ? name.split('.').pop() : ''] || '';
  }

  /** "a/b/c.js" -> { name: 'c.js', dir: 'a/b' }. */
  function splitPath(file) {
    const match = String(file || '').match(/^(.*[\\/])?([^\\/]*)$/);
    return { name: match[2], dir: (match[1] || '').replace(/[\\/]$/, '') };
  }

  /** Line endings and spinner overwrites (a bare \r redraws the line) folded away. */
  function normalize(text) {
    return String(text ?? '').replace(/\r\n/g, '\n').split('\n').map((line) => {
      const at = line.lastIndexOf('\r');
      return at < 0 ? line : (line.slice(at + 1) || line.slice(0, at).split('\r').pop());
    }).join('\n');
  }

  // ---------- Terminal colour ----------
  // eslint-disable-next-line no-control-regex
  const ANSI = /\u001b\[([0-9;:]*)([A-Za-z])/g;
  // eslint-disable-next-line no-control-regex
  const OTHER_ESC = /\u001b(?:\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[()][A-Za-z0-9]|[=>78])/g;
  const hasAnsi = (text) => text.includes('\u001b');

  /** Text with colour escapes -> lines of { text, cls }. cls is '' or e.g. 'an-31 an-b' (see the an-* rules in style.css). */
  function parseAnsi(text) {
    const lines = [];
    let fg = '', bold = false, dim = false, italic = false, underline = false;
    for (const raw of String(text).replace(OTHER_ESC, '').split('\n')) {
      const segments = [];
      let last = 0, match;
      const push = (chunk) => {
        if (!chunk) return;
        const cls = [fg && `an-${fg}`, bold && 'an-b', dim && 'an-d', italic && 'an-i', underline && 'an-u'].filter(Boolean).join(' ');
        segments.push({ text: chunk, cls });
      };
      ANSI.lastIndex = 0;
      while ((match = ANSI.exec(raw))) {
        push(raw.slice(last, match.index));
        last = match.index + match[0].length;
        if (match[2] !== 'm') continue; // cursor movement and erasing mean nothing in a log
        const codes = match[1] === '' ? [0] : match[1].split(/[;:]/).map(Number);
        for (let i = 0; i < codes.length; i++) {
          const code = codes[i];
          if (code === 0) { fg = ''; bold = dim = italic = underline = false; }
          else if (code === 1) bold = true;
          else if (code === 2) dim = true;
          else if (code === 3) italic = true;
          else if (code === 4) underline = true;
          else if (code === 22) bold = dim = false;
          else if (code === 23) italic = false;
          else if (code === 24) underline = false;
          else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) fg = String(code);
          else if (code === 39) fg = '';
          else if (code === 38 || code === 48) i += codes[i + 1] === 5 ? 2 : codes[i + 1] === 2 ? 4 : 0; // 256 / true colour: skipped, the theme's own colours stay readable
        }
      }
      push(raw.slice(last));
      lines.push(segments);
    }
    return lines;
  }

  const stripAnsi = (text) => String(text).replace(ANSI, '').replace(OTHER_ESC, '');

  // ---------- Reads ----------
  /** Claude's Read: "  12\ttext" (older builds use an arrow); Gemini's view: "12: text". null unless the whole body is numbered. */
  function parseNumbered(text) {
    const lines = normalize(text).split('\n');
    for (const [separator, minimum] of [[/^\s*(\d{1,7})(?:\t|\u2192)(.*)$/, 1], [/^\s*(\d{1,7}): ?(.*)$/, 3]]) {
      const head = [], rows = [], tail = [];
      let ok = true;
      for (const line of lines) {
        const match = line.match(separator);
        if (match && tail.length) { ok = false; break; } // a numbered line after a stray one: not a clean read
        if (match) {
          const n = Number(match[1]);
          if (rows.length && n !== rows[rows.length - 1].n + 1) { ok = false; break; }
          rows.push({ n, text: match[2] });
        } else if (!rows.length) head.push(line);
        else tail.push(line);
      }
      if (!ok || rows.length < minimum || head.length > 6) continue;
      while (tail.length && !tail[tail.length - 1].trim()) tail.pop();
      if (tail.length > 24) continue;
      return { rows, head: head.filter((line) => line.trim()), tail };
    }
    return null;
  }

  // ---------- Searches ----------
  /** Grep content mode: "path:12:text" matches, "path-12-text" context, "--" gaps. Grouped by file; null when it isn't that shape. */
  function parseGrep(text) {
    const lines = normalize(text).split('\n');
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    const matchRe = /^((?:[A-Za-z]:)?[^:\n]+?):(\d+):(.*)$/;
    const files = new Set();
    for (const line of lines) { const m = line.match(matchRe); if (m) files.add(m[1]); }
    if (!files.size) return null;
    const groups = [], loose = [];
    let current = null, hits = 0, counted = 0;
    for (const line of lines) {
      let m = line.match(matchRe);
      let context = false;
      if (!m) {
        const dash = line.match(/^((?:[A-Za-z]:)?[^\n]+?)-(\d+)-(.*)$/);
        if (dash && files.has(dash[1])) { m = dash; context = true; }
      }
      if (m && files.has(m[1])) {
        if (!current || current.file !== m[1]) { current = { file: m[1], rows: [] }; groups.push(current); }
        current.rows.push({ n: Number(m[2]), text: m[3], context });
        counted++; if (!context) hits++;
      } else if (line === '--') { if (current) current.rows.push({ gap: true }); counted++; }
      else if (line.trim()) loose.push(line);
    }
    if (counted < lines.filter((line) => line.trim()).length * 0.6) return null;
    return { groups, hits, files: files.size, loose };
  }

  /** A line that is just a path, as Glob prints: "src\\a.js", "C:\\x\\y.png". Paths may hold spaces. */
  function pathLine(line) {
    const text = String(line || '').trim();
    if (!text || text.length > 400 || /[*?"<>|]/.test(text) || /:\d+:/.test(text)) return null;
    const drive = text.replace(/^[A-Za-z]:/, '');
    if (drive.includes(':')) return null;
    if (!/[\\/]/.test(text) && !/^[^\s]+\.[A-Za-z0-9]{1,8}$/.test(text)) return null;
    return { type: IMAGE.test(text) ? 'image' : 'file', value: text };
  }

  /** Glob and directory listings: every line a path (a short note after them is kept as `tail`). */
  function parseFileList(text) {
    const lines = normalize(text).split('\n').filter((line) => line.trim());
    const items = [];
    let at = 0;
    for (; at < lines.length; at++) { const target = pathLine(lines[at]); if (!target) break; items.push({ line: lines[at].trim(), target }); }
    const tail = lines.slice(at);
    if (items.length < 1 || tail.length > 3 || items.length < tail.length * 2) return null;
    return { items, tail };
  }

  /** WebSearch: 'Links: [{"title","url"},...]' followed by the model's own summary. */
  function parseSearch(text) {
    const source = normalize(text);
    const start = source.indexOf('Links: [');
    if (start < 0) return null;
    const open = start + 'Links: '.length;
    let depth = 0, inString = false, end = -1;
    for (let i = open; i < source.length; i++) {
      const c = source[i];
      if (inString) { if (c === '\\') i++; else if (c === '"') inString = false; continue; }
      if (c === '"') inString = true;
      else if (c === '[') depth++;
      else if (c === ']' && --depth === 0) { end = i + 1; break; }
    }
    if (end < 0) return null;
    let links;
    try { links = JSON.parse(source.slice(open, end)); } catch { return null; }
    links = (Array.isArray(links) ? links : []).filter((link) => link && /^https?:\/\//i.test(String(link.url || ''))).map((link) => ({ title: String(link.title || link.url), url: String(link.url) }));
    if (!links.length) return null;
    const query = (source.slice(0, start).match(/query: "([\s\S]*)"/) || [])[1] || '';
    return { query, links, summary: source.slice(end).trim() };
  }
  const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

  // ---------- Terminal output ----------
  /** The script inside a wrapper like `powershell.exe -Command "..."` or `bash -lc '...'`, and the shell that runs it. */
  function unwrapCommand(name, command) {
    const text = String(command || '');
    const wrapped = text.match(/^(.*?)\s-(?:Command|c|lc)\s+(['"])([\s\S]*)\2\s*$/i);
    const script = wrapped ? wrapped[3] : text;
    const hint = `${wrapped ? wrapped[1] : ''} ${name || ''}`;
    const lang = /power\s*shell|pwsh/i.test(hint) ? 'powershell' : /\bbash\b|\bzsh\b|\bsh\b|-lc/i.test(hint) ? 'bash' : /\bcmd\b/i.test(hint) ? 'bat' : /^powershell$/i.test(name) ? 'powershell' : 'bash';
    return { script, lang };
  }

  /** One log line's tone: failures red, warnings amber, successes green; '' for everything else. Only starts of lines count. */
  function lineTone(line) {
    if (/^\s*(?:npm (?:ERR|error)!|error(?:\s|:|\[)|fatal:|Traceback \(|(?:\w+)?Error:|FAIL(?:ED)?\b|✗|✘|×|not ok\b)/i.test(line) && !/^\s*error handling/i.test(line)) return 'err';
    if (/^\s*(?:warn(?:ing)?\b|npm (?:WARN|warn)\b|deprecat)/i.test(line)) return 'warn';
    if (/^\s*(?:✓|✔|PASS(?:ED)?\b|ok\b|success\b)/i.test(line)) return 'ok';
    return '';
  }

  /** A unified diff somewhere in a command's output (git diff, patch). */
  function looksLikeDiff(text) {
    return /^diff --git /m.test(text) || (/^--- .+\n\+\+\+ /m.test(text) && /^@@ .* @@/m.test(text));
  }
  function diffTone(line) {
    if (/^(?:diff --git|index [0-9a-f]+\.\.|--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename (?:from|to) )/.test(line)) return 'meta';
    if (line.startsWith('@@')) return 'hunk';
    if (line[0] === '+') return 'add';
    if (line[0] === '-') return 'del';
    return '';
  }

  /** Output that is one JSON document (an object or an array), worth colouring as such. */
  function looksLikeJson(text) {
    const trimmed = String(text).trim();
    if (trimmed.length < 2 || trimmed.length > 100000 || !/^[[{]/.test(trimmed)) return false;
    try { JSON.parse(trimmed); return true; } catch { return false; }
  }

  /** What a Stop card (TaskStop / KillShell / KillBash) stopped: the stopped command or description, falling back to its task/shell id. */
  function stopTarget(output, fallback = '') {
    const raw = String(output || '').trim();
    const oneLine = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const unescapeJson = (chunk) => {
      try { return oneLine(JSON.parse(`"${chunk}"`)); }
      catch { return oneLine(chunk.replace(/\\n/g, ' ').replace(/\\t/g, ' ').replace(/\\"/g, '"').replace(/\\\\/g, '\\')); }
    };
    if (raw.startsWith('{')) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          const picked = oneLine(parsed.command || parsed.description || parsed.summary || parsed.task_id || parsed.shell_id || parsed.bash_id);
          if (picked) return picked;
          if (typeof parsed.message === 'string') {
            const inner = parsed.message.match(/stopped\s+(?:task|shell|process)\s*:?\s*[\w-]+\s*\(([\s\S]+)\)\s*$/i);
            if (inner) return oneLine(inner[1]);
            const id = parsed.message.match(/(?:task|shell|ID)\s*:?\s*([\w-]+)/i);
            if (id) return id[1];
          }
        }
      } catch {
        // Long outputs arrive truncated to a preview; pull the stopped command or id straight from the JSON text.
        const cmd = raw.match(/"(?:command|description|summary)"\s*:\s*"((?:\\.|[^"\\])+)/);
        if (cmd) return unescapeJson(cmd[1]);
        const msg = raw.match(/"message"\s*:\s*"[^"]*?stopped\s+(?:task|shell|process)\s*:?\s*[\w-]+\s*\(((?:\\.|[^"\\])+)/i);
        if (msg) return unescapeJson(msg[1].replace(/\)\s*$/, ''));
        const id = raw.match(/"(?:task_id|shell_id|bash_id)"\s*:\s*"([^"]+)"/);
        if (id) return id[1];
      }
    }
    const paren = raw.match(/stopped\s+(?:task|shell|process)\s*:?\s*[\w-]+\s*\(([\s\S]+?)\)\s*$/i);
    if (paren) return oneLine(paren[1]);
    const id = raw.match(/(?:stopped\s+(?:task|shell)|killed\s+(?:shell|bash|task)|(?:task|shell)\s+(?:found\s+)?(?:with\s+)?ID)\s*:?\s*([\w-]+)/i);
    if (id) return id[1];
    return oneLine(fallback);
  }

  const api = { langFor, splitPath, normalize, hasAnsi, parseAnsi, stripAnsi, parseNumbered, parseGrep, pathLine, parseFileList, parseSearch, hostOf, unwrapCommand, lineTone, looksLikeDiff, diffTone, looksLikeJson, stopTarget };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else window.toolFormat = api;
})();
