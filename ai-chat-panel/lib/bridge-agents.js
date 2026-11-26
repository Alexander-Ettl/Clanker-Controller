'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { readStatus, indexedJobs, readJobMetadata } = require('./clanker-agent');
const { normalizeEvent: normalizeCopilot } = require('./providers/copilot');

// The worker appends complete JSON lines. A bounded read keeps a large tool result from blocking the extension host.
function readCopilotTools(dir, cursor, terminal, emit) {
  let fd;
  try {
    const file = path.join(dir, 'log.jsonl');
    if (!fs.lstatSync(file).isFile()) return true;
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
  } catch { return true; }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return true;
    const { size } = stat;
    if (cursor.offset >= size) return true;
    const buffer = Buffer.allocUnsafe(Math.min(size - cursor.offset, 512 * 1024));
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, cursor.offset);
    const end = buffer.subarray(0, bytes).lastIndexOf(10) + 1;
    const atEnd = cursor.offset + bytes >= size;
    cursor.offset += terminal && atEnd ? bytes : end || (bytes === buffer.length && !atEnd ? bytes : 0);
    for (const line of buffer.toString('utf8', 0, end).split('\n')) {
      let raw;
      try { raw = JSON.parse(line); } catch { continue; }
      if (!/^(tool\.(?:execution_(?:start|complete|partial_result)|shell_output)|skill\.invoked|assistant\.reasoning|session\.warning)$/.test(raw?.type)) continue;
      const event = normalizeCopilot(raw);
      if (event) emit(event);
    }
    return cursor.offset >= size;
  } finally { fs.closeSync(fd); }
}

// Poll durable job files so detached workers also survive a host reload.
class BridgeAgents {
  constructor(chatId, emit, { home } = {}) { this.chatId = chatId; this.emit = emit; this.home = home; this.seen = new Map(); this.active = false; }
  /** The job folders to look at: the project's own `_work/clanker`, plus every job this chat started under any other --cwd. */
  jobDirs(cwd) {
    const root = path.resolve(cwd, '_work', 'clanker');
    const dirs = new Set(indexedJobs(this.chatId, this.home));
    try { for (const name of fs.readdirSync(root)) dirs.add(path.join(root, name)); } catch { /* no local jobs */ }
    return dirs;
  }
  poll(cwd) {
    if (!this.chatId) return;
    this.active = false;
    for (const dir of this.jobDirs(cwd)) {
      try {
        const request = readJobMetadata(path.join(dir, 'request.json'));
        if (request?.from !== this.chatId) continue;
        const status = readStatus(dir, { readOnly: true });
        const id = `bridge:${dir}`;
        const previous = this.seen.get(id);
        const working = status.state === 'queued' || status.state === 'running';
        this.active ||= working;
        const base = { id, agent: request.agent, model: request.model, effort: request.effort, external: true };
        if (!previous) this.emit({ ...base, type: 'subagent_start', description: request.id, subagentType: 'Cross-vendor task', prompt: request.task });
        const cursor = previous || { offset: 0, state: null };
        this.seen.set(id, cursor);
        const drained = request.agent !== 'copilot' || (!working && cursor.state === status.state)
          || readCopilotTools(dir, cursor, !working, (event) => this.emit({ ...base, type: 'subagent_event', event }));
        if (!drained) this.active = true;
        if (!working && !drained) continue;
        if (cursor.state !== status.state) {
          this.emit({ ...base, type: 'subagent_status', status: working ? 'background' : status.state === 'done' ? 'completed' : status.state === 'cancelled' ? 'stopped' : 'failed' });
          if (!working) {
            const result = status.resultFile === 'result.md' ? `\nResult: ${path.join(dir, 'result.md')}` : '';
            this.emit({ ...base, type: 'subagent_event', event: { type: 'delta', text: `${status.state}${status.error ? `: ${status.error}` : ''}${result}` } });
          }
        }
        cursor.state = status.state;
      } catch { /* A worker may be replacing its status file; retry next poll. */ }
    }
  }
}
module.exports = { BridgeAgents };
