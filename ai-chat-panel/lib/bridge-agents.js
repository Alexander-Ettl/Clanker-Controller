'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { readStatus, indexedJobs, readJobMetadata } = require('./clanker-agent');

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
        if (!previous || previous !== status.state) {
          this.emit({ ...base, type: 'subagent_status', status: working ? 'background' : status.state === 'done' ? 'completed' : status.state === 'cancelled' ? 'stopped' : 'failed' });
          if (!working) {
            const result = status.resultFile === 'result.md' ? `\nResult: ${path.join(dir, 'result.md')}` : '';
            this.emit({ ...base, type: 'subagent_event', event: { type: 'delta', text: `${status.state}${status.error ? `: ${status.error}` : ''}${result}` } });
          }
        }
        this.seen.set(id, status.state);
      } catch { /* A worker may be replacing its status file; retry next poll. */ }
    }
  }
}
module.exports = { BridgeAgents };
