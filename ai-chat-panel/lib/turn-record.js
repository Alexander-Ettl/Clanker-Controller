'use strict';

// Small pieces the editor's scheduler and the headless runner both need, kept out of extension.js (which needs `vscode`).

const { RECORDED_OUTPUT_CHARS } = require('./chat-transcript.js');
const { quotaFor } = require('./model-catalog.js');
const { stopTarget } = require('../media/tool-format.js');

const STOP_TOOL = /^(?:task_?stop|kill_?(?:shell|bash))$/i;

/** Marks a recorded tool step finished and keeps its (capped) output, diff and duration. */
function recordToolEnd(chat, event) {
  if (!event.toolId) return;
  const step = chat.messages.findLast(entry => entry.role === 'tool' && entry.event?.toolId === event.toolId);
  if (!step) return;
  const startedAt = step.startedAt ?? step.event?.startedAt;
  const durationMs = Number.isFinite(event.durationMs) ? event.durationMs : (Number.isFinite(startedAt) ? Math.max(0, Date.now() - startedAt) : undefined);
  if (Number.isFinite(durationMs)) { step.durationMs = durationMs; event.durationMs = durationMs; }
  step.done = true;
  step.error = Boolean(event.error);
  const stopped = STOP_TOOL.test(String(step.event?.name || '')) ? stopTarget(event.output, step.event?.command || '') : '';
  step.event = { ...step.event, ...(stopped ? { command: stopped } : {}), ...(Number.isFinite(durationMs) ? { durationMs } : {}), output: String(event.output || '').slice(0, RECORDED_OUTPUT_CHARS), diff: event.diff || step.event.diff, ...(Number.isInteger(event.exitCode) ? { exitCode: event.exitCode } : {}) };
}

/** True when the model behind a task (or an agent name) has usage left. A missing live Antigravity number never blocks it. */
function quotaAvailable(quotas, modelOrTask) {
  const agent = typeof modelOrTask === 'string' ? modelOrTask : modelOrTask?.model;
  const quota = typeof modelOrTask === 'string' ? quotas?.[agent] : quotaFor(quotas, modelOrTask?.modelId, agent);
  if (quota?.secondary?.remaining === 0) return false;
  return agent === 'gemini' && typeof quota?.remaining !== 'number'
    ? true // no live Antigravity number: never block it
    : typeof quota?.remaining === 'number' && quota.remaining > 0;
}

module.exports = { recordToolEnd, quotaAvailable };
