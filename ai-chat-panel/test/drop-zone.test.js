'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDropZone, QUIET_MS } = require('../media/drop-zone');

// A document/window stand-in plus a hand-driven clock, so "nothing arrives any more" can be tested without waiting.
function setup() {
  const listeners = { doc: {}, win: {} };
  const target = (key) => ({ addEventListener: (name, fn) => { (listeners[key][name] ||= []).push(fn); } });
  const doc = { ...target('doc'), visibilityState: 'visible' };
  const win = { ...target('win'), innerWidth: 400, innerHeight: 800 };
  let now = 0;
  const timers = new Map();
  let nextId = 1;
  const states = [];
  const drops = [];
  const zone = createDropZone({
    doc, win,
    setActive: (on) => states.push(on),
    onDrop: (event) => drops.push(event),
    schedule: (fn, ms) => { timers.set(nextId, { fn, at: now + ms }); return nextId++; },
    cancel: (id) => timers.delete(id),
  });
  const fire = (key, name, event = {}) => (listeners[key][name] || []).forEach((fn) => fn({ preventDefault() {}, ...event }));
  const advance = (ms) => {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
  };
  const files = { dataTransfer: { types: ['Files'] } };
  return { zone, fire, advance, states, drops, files, doc };
}

test('a file drag shows the overlay and a drop ends it', () => {
  const { zone, fire, states, drops, files } = setup();
  fire('doc', 'dragenter', files);
  assert.equal(zone.isActive(), true);
  fire('doc', 'drop', files);
  assert.equal(zone.isActive(), false);
  assert.equal(drops.length, 1);
  assert.deepEqual(states, [true, false]);
});

test('the overlay clears when the drag goes quiet (Shift released, IDE took the drag)', () => {
  const { zone, fire, advance, files } = setup();
  fire('doc', 'dragenter', files);
  advance(QUIET_MS - 1);
  fire('doc', 'dragover', files); // still hovering: the keep-alive restarts
  advance(QUIET_MS - 1);
  assert.equal(zone.isActive(), true);
  advance(2);
  assert.equal(zone.isActive(), false);
});

test('Escape, an ordinary mouse move, blur and a hidden tab each end a stuck overlay', () => {
  for (const end of [
    (s) => s.fire('doc', 'keydown', { key: 'Escape' }),
    (s) => s.fire('doc', 'pointermove'),
    (s) => s.fire('doc', 'dragend'),
    (s) => s.fire('win', 'blur'),
    (s) => { s.doc.visibilityState = 'hidden'; s.fire('doc', 'visibilitychange'); },
  ]) {
    const s = setup();
    s.fire('doc', 'dragenter', s.files);
    end(s);
    assert.equal(s.zone.isActive(), false);
  }
});

test('other keys do not flicker the overlay; leaving the window edge ends it, crossing children does not', () => {
  const s = setup();
  s.fire('doc', 'dragenter', s.files);
  s.fire('doc', 'keydown', { key: 'Shift' });
  s.fire('doc', 'dragleave', { clientX: 120, clientY: 300 });
  assert.equal(s.zone.isActive(), true);
  s.fire('doc', 'dragleave', { clientX: 0, clientY: 300 });
  assert.equal(s.zone.isActive(), false);
});

test('drags that are not files or URIs are left alone', () => {
  const s = setup();
  let prevented = false;
  const text = { dataTransfer: { types: ['text/plain'] }, preventDefault() { prevented = true; } };
  s.fire('doc', 'dragenter', text);
  s.fire('doc', 'dragover', text);
  s.fire('doc', 'drop', text);
  assert.equal(s.zone.isActive(), false);
  assert.equal(prevented, false);
  assert.equal(s.drops.length, 0);
});

test('Explorer URI drags count as attachment drags', () => {
  const s = setup();
  s.fire('doc', 'dragenter', { dataTransfer: { types: ['application/vnd.code.uri-list'] } });
  assert.equal(s.zone.isActive(), true);
});

const dt = (data, files = []) => ({ files, getData: (type) => data[type] || '' });

test('a multi-file Explorer drag yields every file, whichever list carries it', () => {
  const { droppedUris } = require('../media/drop-zone');
  const a = 'file:///c%3A/p/a.js';
  const b = 'file:///c%3A/p/b.js';
  assert.deepEqual(droppedUris(dt({ 'application/vnd.code.uri-list': `${a}\r\n${b}\r\n` })), [a, b]);
  assert.deepEqual(droppedUris(dt({ ResourceURLs: JSON.stringify([a, b]) })), [a, b]);
  assert.deepEqual(droppedUris(dt({ CodeEditors: JSON.stringify([{ resource: a }, { resource: b }]) })), [a, b]);
  // lists that overlap are merged without duplicates
  assert.deepEqual(droppedUris(dt({ 'text/uri-list': `# comment\n${a}`, ResourceURLs: JSON.stringify([a, b]) })), [a, b]);
});

test('plain-text paths are the fallback, and never used for OS file drops', () => {
  const { droppedUris } = require('../media/drop-zone');
  assert.deepEqual(droppedUris(dt({ 'text/plain': 'C:\\p\\a b.js\nC:\\p\\c.js' })), ['file:///C:/p/a%20b.js', 'file:///C:/p/c.js']);
  assert.deepEqual(droppedUris(dt({ 'text/plain': 'just some words' })), []);
  assert.deepEqual(droppedUris(dt({ 'text/plain': 'C:\\p\\a.js' }, [{ name: 'a.js' }])), []);
});

test('JSON-only IDE drags count as attachment drags', () => {
  const { isAttachmentDrag } = require('../media/drop-zone');
  assert.equal(isAttachmentDrag({ dataTransfer: { types: ['ResourceURLs', 'text/plain'] } }), true);
  assert.equal(isAttachmentDrag({ dataTransfer: { types: ['text/plain'] } }), false);
});

test('dragenter, dragover and drop call preventDefault and stopPropagation so VS Code does not block external drops without Shift', () => {
  const { fire } = setup();
  for (const name of ['dragenter', 'dragover', 'drop']) {
    let prevented = false, stopped = false;
    fire('doc', name, {
      dataTransfer: { types: ['Files'] },
      preventDefault() { prevented = true; },
      stopPropagation() { stopped = true; },
    });
    assert.equal(prevented, true, `${name} must call preventDefault`);
    assert.equal(stopped, true, `${name} must call stopPropagation`);
  }
});

test('Linux Dolphin/GTK drags with Files + text/uri-list attach files; Explorer drags mention; URI-only or folder drops route to attachUris', () => {
  const { classifyDrop, isAttachmentDrag, droppedUris } = require('../media/drop-zone');
  const png = { name: 'shot.png', type: 'image/png', size: 1234 };
  const kdeUri = 'file:///home/user/Pictures/shot.png';

  // KDE Dolphin / GTK OS drag: carries BOTH Files and text/uri-list (no VS Code IDE MIME types).
  const dolphin = {
    types: ['Files', 'text/uri-list', 'application/x-kde-urilist'],
    files: [png],
    getData: (t) => (t === 'text/uri-list' ? `${kdeUri}\r\n` : ''),
  };
  assert.equal(isAttachmentDrag({ dataTransfer: dolphin }), true);
  assert.deepEqual(classifyDrop(dolphin), { kind: 'files', files: [png], uris: [kdeUri] });

  // Wayland / KIO URI-only OS drag (no File blobs populated, only text/uri-list or x-special/gnome-copied-files).
  const gnome = {
    types: ['x-special/gnome-copied-files'],
    files: [],
    getData: (t) => (t === 'x-special/gnome-copied-files' ? `copy\n${kdeUri}\n` : ''),
  };
  assert.equal(isAttachmentDrag({ dataTransfer: gnome }), true);
  assert.deepEqual(classifyDrop(gnome), { kind: 'uris', uris: [kdeUri] });

  // Dropping a folder from Dolphin hands URIs to the host instead of trying FileReader on a directory.
  const folderDrop = {
    types: ['Files', 'text/uri-list'],
    files: [{ name: 'docs', size: 0 }],
    items: [{ kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true }) }],
    getData: (t) => (t === 'text/uri-list' ? 'file:///home/user/docs\n' : ''),
  };
  assert.deepEqual(classifyDrop(folderDrop), { kind: 'uris', uris: ['file:///home/user/docs'] });

  // VS Code Explorer drag still produces workspace @-mentions.
  const explorer = {
    types: ['application/vnd.code.uri-list', 'text/uri-list'],
    files: [],
    getData: (t) => (t === 'application/vnd.code.uri-list' ? 'file:///home/user/dev/a.js\r\n' : ''),
  };
  assert.deepEqual(classifyDrop(explorer), { kind: 'mentions', uris: ['file:///home/user/dev/a.js'] });

  // Plain-text path fallback encodes # and ? safely on Linux.
  assert.deepEqual(droppedUris(dt({ 'text/plain': '/home/user/notes #1?v=2.md' })), ['file:///home/user/notes%20%231%3Fv=2.md']);
});
