'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * What agy keeps on disk about a conversation, which its headless stream does not repeat. The stream says a tool step started and
 * ended; the result of the step, and the background tasks (`run_command` that outlived its wait, managed with `manage_task`),
 * live under <brain>/<conversation id>/.system_generated/:
 *   steps/<step index>/output.txt  the step's result (when the step produced one)
 *   tasks/task-<n>.log             what a background task has printed so far
 *   logs/transcript_full.jsonl     every step, one JSON line each (the fallback when the step has no output.txt)
 * Read here so a Gemini card can show its result like Claude's and Codex's, and a ManageTask card can say which task it means.
 */
const ROOT_DIRS = ['antigravity-cli', 'antigravity-ide'];
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_READ = 256 * 1024; // of a step's result; a longer one arrives as a preview and the card fetches the rest when opened
const TRANSCRIPT_TAIL = 768 * 1024; // how far back from the end of the transcript to look for a step

const at = (x) => (typeof x === 'string' ? x : '');

function brainDir(conversationId, home = os.homedir()) {
  if (!ID.test(at(conversationId))) return null;
  for (const root of ROOT_DIRS) {
    const dir = path.join(home, '.gemini', root, 'brain', conversationId, '.system_generated');
    try { if (fs.statSync(dir).isDirectory()) return dir; } catch { /* not in this root */ }
  }
  return null;
}

/** The first `max` bytes of a file, or its last `max` bytes with `fromEnd`. */
function readPart(file, max, fromEnd = false) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, max), start = fromEnd ? size - length : 0;
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    return { text: buffer.toString('utf8'), whole: length === size };
  } finally { fs.closeSync(fd); }
}

/** A result without the "Created At / Completed At" lines agy puts on top of it. */
function cleanResult(text) {
  return at(text).replace(/\r\n/g, '\n').split('\n').filter((line) => !/^(Created|Completed) At:/.test(line)).join('\n').trim();
}

/** "…task id: <conversation>/task-262\nTask Description: <command>\nTask logs are available at…" -> { id, description }. */
function parseBackgroundTask(text) {
  const id = /background task with task id:\s*(\S+)/.exec(text)?.[1];
  if (!id) return null;
  const description = /Task Description:\s*([\s\S]*?)\n(?:Task logs are available|Log output:|Log:)/.exec(text)?.[1]?.trim() || '';
  return { id, description };
}

/**
 * The result of one step of a conversation: { text, task } or null while agy has not written it. `task` is set when the step started
 * a background task. Never throws; a missing file or an unknown agy layout is just "nothing to show".
 */
function readStepResult(conversationId, stepIndex, { home } = {}) {
  const dir = brainDir(conversationId, home);
  if (!dir || !Number.isSafeInteger(stepIndex) || stepIndex < 0) return null;
  let text = null;
  try { text = readPart(path.join(dir, 'steps', String(stepIndex), 'output.txt'), MAX_READ).text; } catch { /* no output file for this step */ }
  if (text === null) {
    try {
      const { text: tail, whole } = readPart(path.join(dir, 'logs', 'transcript_full.jsonl'), TRANSCRIPT_TAIL, true);
      const lines = tail.split('\n');
      if (!whole) lines.shift(); // starts mid-line
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes(`"step_index":${stepIndex},`) && !lines[i].includes(`"step_index": ${stepIndex},`)) continue;
        let entry;
        try { entry = JSON.parse(lines[i]); } catch { continue; }
        if (entry?.step_index === stepIndex && entry.type === 'GENERIC' && typeof entry.content === 'string') { text = entry.content; break; }
      }
    } catch { /* no transcript either */ }
  }
  if (text === null) return null;
  return { text: cleanResult(text), task: parseBackgroundTask(text) };
}

/** The number that ends a task id: "<conversation>/task-262" -> "task-262". */
const shortTaskId = (id) => at(id).split('/').pop();

/** The last (or with `head` the first) `lines` lines a background task has printed, '' when there is none. */
function readTaskLog(conversationId, taskId, { home, lines = 12, head = false } = {}) {
  const dir = brainDir(conversationId, home);
  const name = shortTaskId(taskId);
  if (!dir || !/^task-\d+$/.test(name)) return '';
  try {
    const { text } = readPart(path.join(dir, 'tasks', `${name}.log`), 32 * 1024, !head);
    const kept = text.replace(/\r\n/g, '\n').split('\n').map((line) => line.slice(line.lastIndexOf('\r') + 1)).filter((line) => line.trim());
    return (head ? kept.slice(0, lines) : kept.slice(-lines)).join('\n'); // head: how it began (what it is), else how it is doing
  } catch { return ''; }
}

/** One line to call a task by: the first line of what it runs, else of what it has printed. */
function taskLabel(description, log) {
  const line = (at(description) || at(log)).split('\n').map((l) => l.trim()).find(Boolean) || '';
  return line.length > 90 ? `${line.slice(0, 89)}…` : line;
}

module.exports = { brainDir, readStepResult, readTaskLog, taskLabel, parseBackgroundTask, cleanResult, shortTaskId };
