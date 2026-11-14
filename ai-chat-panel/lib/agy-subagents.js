'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * agy starts a subagent with `invoke_subagent` and returns at once; the subagent is its own conversation that
 * appends every step to <brain>/<conversation id>/.system_generated/logs/transcript.jsonl. headless agy streams
 * nothing of it, so this follows that file and turns its steps into the same `subagent_*` events Claude's
 * subagents produce, which is all the robot chip and its Agents sheet need.
 */
const POLL_MS = 1500;
const FIND_MS = 90000; // how long to look for a transcript that never shows up
const IDLE_MS = 10 * 60000; // a transcript that stops growing this long is treated as ended
const ROOT_DIRS = ['antigravity-cli', 'antigravity-ide'];
const at = (x) => (typeof x === 'string' ? x : '');

/** Tool arguments arrive JSON-encoded a second time ("\"C:\\\\x\""): undo that so the card shows the plain value. */
function plainArgs(args = {}) {
  const out = {};
  for (const [key, value] of Object.entries(args || {})) {
    if (typeof value === 'string' && /^".*"$/s.test(value)) { try { out[key] = JSON.parse(value); continue; } catch { /* keep as is */ } }
    out[key] = value;
  }
  return out;
}

/** The result text of a tool step, without the "Created At / Completed At" header lines agy puts on it. */
function stepOutput(content) {
  return at(content).split('\n').filter((line) => !/^(Created|Completed) At:/.test(line)).join('\n').trim().slice(0, 2000);
}

/**
 * One transcript step -> the events for the viewer. `state.pending` holds the tool calls still waiting for their
 * result step (results come back one step each, in call order). Returns { events, finished }.
 */
function transcriptEvents(entry, state, describe) {
  const events = [];
  let finished = false;
  if (entry?.source !== 'MODEL') return { events, finished };
  if (entry.type === 'PLANNER_RESPONSE') {
    if (at(entry.thinking).trim()) events.push({ type: 'thought', text: entry.thinking.trim() });
    const calls = Array.isArray(entry.tool_calls) ? entry.tool_calls : [];
    if (at(entry.content).trim()) events.push({ type: 'delta', text: entry.content.trim() });
    calls.forEach((call, index) => {
      const toolId = `${entry.step_index}-${index}`;
      const rawName = at(call?.name) || 'tool';
      const params = plainArgs(call?.args);
      const name = rawName === 'run_command' ? 'bash' : /^(write_to_file|write_file|edit_file|(multi_)?replace_file_content)$/.test(rawName) ? 'edit' : rawName;
      events.push({ type: 'tool_start', toolId, name, command: describe(rawName, params), file: at(params.TargetFile) || at(params.Path) });
      state.pending.push(toolId);
    });
    finished = !calls.length && entry.status === 'DONE' && Boolean(at(entry.content).trim());
  } else if (entry.type === 'GENERIC' && state.pending.length) {
    const toolId = state.pending.shift();
    const failed = entry.status === 'ERROR';
    events.push({ type: 'tool_end', toolId, output: failed ? at(entry.error) || stepOutput(entry.content) : stepOutput(entry.content) || (entry.media?.length ? 'image' : ''), error: failed });
  }
  return { events, finished };
}

class AgySubagents {
  constructor({ emit, describe, home = os.homedir(), pollMs = POLL_MS, findMs = FIND_MS, idleMs = IDLE_MS, now = Date.now } = {}) {
    this.emit = emit;
    this.describe = describe || (() => '');
    this.roots = ROOT_DIRS.map((dir) => path.join(home, '.gemini', dir, 'brain'));
    this.pollMs = pollMs; this.findMs = findMs; this.idleMs = idleMs; this.now = now;
    this.watchers = new Map(); // viewer id -> { file, offset, partial, state, timer, startedAt, lastGrowth, ... }
    this.claimed = new Set(); // transcripts already followed, so two launches never share one
  }

  /** A subagent was launched: `id` names it in the viewer, `parentId` is the conversation that started it. */
  launch({ id, parentId, conversationId, role, typeName, prompt }) {
    if (this.watchers.has(id)) return;
    const watcher = { id, parentId, conversationId, prompt: at(prompt), file: null, offset: 0, partial: '', state: { pending: [] }, startedAt: this.now(), lastGrowth: this.now(), timer: null };
    this.watchers.set(id, watcher);
    this.emit({ type: 'subagent_start', id, description: at(role), subagentType: at(typeName) || 'self', prompt: at(prompt), background: true });
    watcher.timer = setInterval(() => this.poll(watcher), this.pollMs);
    watcher.timer.unref?.();
    this.poll(watcher);
  }

  /** The launch call came back: the subagent keeps working after it. */
  launched(id, conversationId) {
    const watcher = this.watchers.get(id);
    if (!watcher) return; // it already finished (or was stopped) before its launch call reported back
    if (conversationId && !watcher.conversationId) watcher.conversationId = conversationId;
    this.emit({ type: 'subagent_end', id, output: '', error: false, launched: true });
  }

  failed(id, output) {
    this.stop(id);
    this.emit({ type: 'subagent_end', id, output: at(output), error: true, launched: false });
  }

  /** The transcript that belongs to this launch: named by its conversation id, else the newest one whose first message is from the parent with this prompt. */
  findTranscript(watcher) {
    const suffix = path.join('.system_generated', 'logs', 'transcript.jsonl');
    if (watcher.conversationId) {
      for (const root of this.roots) { const file = path.join(root, watcher.conversationId, suffix); if (fs.existsSync(file)) return file; }
      return null;
    }
    const probe = JSON.stringify(watcher.prompt.slice(0, 120)).slice(1, -1); // as the transcript's first line spells it
    for (const root of this.roots) {
      let names = [];
      try { names = fs.readdirSync(root); } catch { continue; }
      for (const name of names) {
        const file = path.join(root, name, suffix);
        if (this.claimed.has(file)) continue;
        try {
          if (fs.statSync(file).mtimeMs < watcher.startedAt - 15000) continue;
          const fd = fs.openSync(file, 'r');
          const buffer = Buffer.alloc(8192);
          const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
          fs.closeSync(fd);
          const head = buffer.toString('utf8', 0, read);
          if ((!watcher.parentId || head.includes(`sender=${watcher.parentId}`)) && head.includes(probe)) return file;
        } catch { /* not a subagent transcript, or still being created */ }
      }
    }
    return null;
  }

  poll(watcher) {
    if (!this.watchers.has(watcher.id)) return;
    if (!watcher.file) {
      watcher.file = this.findTranscript(watcher);
      if (watcher.file) this.claimed.add(watcher.file);
      else {
        if (this.now() - watcher.startedAt > this.findMs) this.finish(watcher, 'ended');
        return;
      }
    }
    let size;
    try { size = fs.statSync(watcher.file).size; } catch { return; }
    if (size < watcher.offset) { watcher.offset = 0; watcher.partial = ''; }
    if (size === watcher.offset) {
      if (this.now() - watcher.lastGrowth > this.idleMs) this.finish(watcher, 'ended');
      return;
    }
    watcher.lastGrowth = this.now();
    let text;
    try {
      const fd = fs.openSync(watcher.file, 'r');
      const buffer = Buffer.alloc(size - watcher.offset);
      fs.readSync(fd, buffer, 0, buffer.length, watcher.offset);
      fs.closeSync(fd);
      text = buffer.toString('utf8');
    } catch { return; }
    watcher.offset = size;
    const lines = (watcher.partial + text).split('\n');
    watcher.partial = lines.pop(); // the last line may still be half written
    for (const line of lines) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      const { events, finished } = transcriptEvents(entry, watcher.state, this.describe);
      for (const event of events) this.emit({ type: 'subagent_event', id: watcher.id, event });
      if (finished) { this.finish(watcher, 'completed'); return; }
    }
  }

  finish(watcher, status) {
    this.stop(watcher.id);
    this.emit({ type: 'subagent_status', id: watcher.id, status });
  }

  stop(id) {
    const watcher = this.watchers.get(id);
    if (!watcher) return;
    clearInterval(watcher.timer);
    this.watchers.delete(id);
  }

  /** The agy process is gone and took its subagents along: read what they wrote last, then close whatever is unfinished. */
  endAll(status) {
    for (const watcher of [...this.watchers.values()]) {
      if (status !== 'stopped') this.poll(watcher);
      if (this.watchers.has(watcher.id)) this.finish(watcher, status);
    }
  }
}

module.exports = { AgySubagents, transcriptEvents, plainArgs };
