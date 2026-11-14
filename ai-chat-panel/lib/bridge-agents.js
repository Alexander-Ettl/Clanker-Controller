'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { readStatus } = require('./clanker-agent');

// Poll durable job files so detached workers also survive a host reload.
class BridgeAgents {
  constructor(chatId, emit) { this.chatId = chatId; this.emit = emit; this.seen = new Map(); this.active = false; }
  poll(cwd) {
    if (!this.chatId) return;
    const root = path.join(cwd, '_work', 'clanker');
    let names;
    try { names = fs.readdirSync(root); } catch { return; }
    this.active = false;
    for (const name of names) {
      try {
        const dir = path.join(root, name);
        const request = JSON.parse(fs.readFileSync(path.join(dir, 'request.json'), 'utf8'));
        if (request.from !== this.chatId) continue;
        const status = readStatus(dir);
        const id = `bridge:${dir}`;
        const previous = this.seen.get(id);
        const working = status.state === 'queued' || status.state === 'running';
        this.active ||= working;
        const base = { id, agent: request.agent, model: request.model, effort: request.effort, external: true };
        if (!previous) this.emit({ ...base, type: 'subagent_start', description: request.id, subagentType: 'Cross-vendor task', prompt: request.task });
        if (!previous || previous !== status.state) {
          this.emit({ ...base, type: 'subagent_status', status: working ? 'background' : status.state === 'done' ? 'completed' : status.state === 'cancelled' ? 'stopped' : 'failed' });
          if (!working) this.emit({ ...base, type: 'subagent_event', event: { type: 'delta', text: `${status.state}${status.error ? `: ${status.error}` : ''}\nResult: ${path.join(dir, status.resultFile || 'result.md')}` } });
        }
        this.seen.set(id, status.state);
      } catch { /* A worker may be replacing its status file; retry next poll. */ }
    }
  }
}
module.exports = { BridgeAgents };
