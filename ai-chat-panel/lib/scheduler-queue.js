'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const providers = require('./providers');

const MAX_QUEUE_SIZE = 50;
const RETRY_BACKOFF_MS = 60000;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MODELS = { has: (agent) => providers.has(agent) }; // any registered provider (lib/providers)
// Statuses still shown in the Scheduled tab and counted against MAX_QUEUE_SIZE.
const ACTIVE = new Set(['pending', 'dispatched', 'interrupted']);
const MIN_REPEAT_MINUTES = 1;
const MAX_REPEAT_MINUTES = 24 * 60;
const DEFAULT_REPEAT_RUNS = 24; // a loop never runs forever by accident
const MAX_REPEAT_RUNS = 500;
const DEFAULT_REPEAT_DAYS = 7;

/**
 * A repeating prompt (`/loop 5m <prompt>`): the interval, how many runs at most and when it expires. Always bounded, so a
 * forgotten loop ends by itself. Returns null for "not repeating"; throws for a bad interval.
 */
function normalizeRecurrence(raw, now = Date.now()) {
  if (raw === undefined || raw === null) return null;
  const every = Number(raw.everyMinutes);
  if (!Number.isFinite(every) || every < MIN_REPEAT_MINUTES || every > MAX_REPEAT_MINUTES) throw new Error(`A repeating prompt needs an interval of ${MIN_REPEAT_MINUTES} to ${MAX_REPEAT_MINUTES} minutes.`);
  const maxRuns = raw.maxRuns === undefined ? DEFAULT_REPEAT_RUNS : Math.floor(Number(raw.maxRuns));
  if (!Number.isFinite(maxRuns) || maxRuns < 1 || maxRuns > MAX_REPEAT_RUNS) throw new Error(`A repeating prompt runs 1 to ${MAX_REPEAT_RUNS} times.`);
  const expires = raw.expiresAt === undefined ? now + DEFAULT_REPEAT_DAYS * 86400000 : Date.parse(raw.expiresAt);
  if (!Number.isFinite(expires) || expires <= now) throw new Error('A repeating prompt needs an expiry in the future.');
  return { everyMinutes: Math.round(every * 1000) / 1000, maxRuns, expiresAt: new Date(expires).toISOString(), run: Math.max(1, Math.floor(Number(raw.run) || 1)) };
}

function taskId() {
  return `sched_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
}

function safeName(name) {
  return path.basename(String(name || 'attachment.bin')).replace(/[^a-zA-Z0-9._-]/g, '_');
}

/** A small, disk-backed FIFO queue.  Attachments are copied before the task is
 * made visible, so a queued task never relies on a browser-temp file. */
class SchedulerQueue {
  constructor({ workspaceDir = process.cwd(), sessionDir, keepAwake = null } = {}) {
    this.keepAwake = keepAwake; this.awake = null; this.disposed = false;
    this.workspaceDir = path.resolve(workspaceDir);
    this.sessionDir = path.resolve(sessionDir || path.join(this.workspaceDir, '.clanker', 'session'));
    this.filePath = path.join(this.sessionDir, 'scheduler-queue.json');
    this.stagingDir = path.join(this.sessionDir, 'scheduler');
    this.tasks = [];
    this.loaded = false;
    this.writeTail = Promise.resolve();
    this.draftFiles = new Map();
  }

  /** Windows can refuse a read (EPERM/EBUSY) while an indexer or sync client holds the file; that passes in moments. */
  async readFile() {
    for (let attempt = 0; ; attempt++) {
      try { return await fs.readFile(this.filePath, 'utf8'); } catch (error) {
        if (attempt >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
        await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
      }
    }
  }
  /** Reads the queue again from disk (after a headless run changed it behind this process's back). */
  async reload() { this.loaded = false; await this.load(); }
  async load() {
    if (this.loaded) return;
    this.guard?.(); // the editor sets this: it throws while the headless runner owns the queue file
    await fs.mkdir(this.sessionDir, { recursive: true });
    try {
      const parsed = JSON.parse(await this.readFile());
      this.tasks = Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Could not read scheduler queue: ${error.message}`);
      this.tasks = [];
    }
    this.loaded = true;
    let changed = false;
    for (const task of this.tasks) {
      delete task.editing; // An editor from a previous window/session no longer holds this task.
      if (!Array.isArray(task.attachments)) task.attachments = [];
      // P17-H: a queue loads once per extension host, before any CLI is
      // spawned, so a persisted 'dispatched' task lost its process to a
      // restart, crash, or window reload.
      if (task.status === 'dispatched') {
        task.status = 'interrupted';
        task.interruptedAt = new Date().toISOString();
        task.interruptedReason = 'Execution interrupted by system restart, shutdown, or window reload';
        changed = true;
      }
      for (const attachment of task.attachments) {
        // Staged copies live in this queue's own folder (session/scheduler), outside the workspace: both are allowed.
        // Checking the workspace alone marked every scheduled prompt with an image as missing on the next reload.
        const absolute = path.resolve(this.workspaceDir, attachment.absolutePath || attachment.relativePath || '');
        // Windows paths ignore case (VS Code even varies the drive letter between sessions), so compare them that way.
        const fold = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
        const inside = (root) => fold(absolute).startsWith(fold(root + path.sep));
        if (!(inside(this.workspaceDir) || inside(this.stagingDir)) || !(await exists(absolute))) {
          task.status = 'attachment-missing';
          changed = true;
          break;
        }
      }
    }
    if (alignClaudeResets(this.tasks)) changed = true;
    // A failed housekeeping write must not leave the queue unusable: the tasks are already loaded in memory.
    if (changed) await this.persist().catch(() => {});
    this.syncAwake();
  }

  async enqueue(task, rawAttachments = []) {
    await this.load();
    return this.withWrite(async () => {
      if (isContinue(task)) {
        const existing = this.tasks.find(item => item.chatId === task.chatId && item.model === task.model && ACTIVE.has(item.status) && isContinue(item));
        if (existing) return copyTask(existing);
      }
      const active = this.tasks.filter((item) => ACTIVE.has(item.status));
      if (active.length >= MAX_QUEUE_SIZE) throw new Error(`Scheduler queue is full (maximum ${MAX_QUEUE_SIZE} active tasks).`);
      if (!MODELS.has(task?.model)) throw new Error(`Scheduled task must target ${providers.ids().join(', ')}.`);
      if (!String(task?.prompt || '').trim()) throw new Error('Scheduled task prompt is required.');
      if (!['quota-reset', 'fixed-time'].includes(task?.dispatchTrigger)) throw new Error('Scheduled task has an invalid dispatch trigger.');
      if (task.dispatchTrigger === 'fixed-time' && Number.isNaN(Date.parse(task.dispatchTime || ''))) throw new Error('Fixed-time tasks require an ISO dispatchTime.');

      const recurrence = normalizeRecurrence(task.recurrence);
      if (recurrence && task.dispatchTrigger !== 'fixed-time') throw new Error('A repeating prompt runs on a clock, not on a usage reset.');
      if (recurrence && rawAttachments.length) throw new Error('A repeating prompt can\'t carry attachments.');
      const id = taskId();
      const attachmentDir = path.join(this.stagingDir, id, 'attachments');
      const attachments = await this.stageAttachments(rawAttachments, attachmentDir);
      const scheduled = {
        id,
        model: task.model,
        ...(task.dispatchTrigger === 'quota-reset' && task.resetWindow === '7d' ? { resetWindow: '7d' } : {}),
        ...(task.projectId ? { projectId: String(task.projectId) } : {}),
        ...(task.workspaceDir ? { workspaceDir: String(task.workspaceDir) } : {}),
        ...(task.modelId && task.modelId !== 'auto' ? { modelId: String(task.modelId) } : {}), // P17-X: exact tier for badges
        prompt: String(task.prompt),
        ...(task.chatId ? { chatId: String(task.chatId) } : {}), // resumes in that chat when it fires
        attachments,
        dispatchTrigger: task.dispatchTrigger,
        ...(task.dispatchTrigger === 'fixed-time' ? { dispatchTime: new Date(task.dispatchTime).toISOString() } : {}),
        // "When the usage resets" is not "as soon as there is usage": the reset moment the model's quota reported when this
        // was scheduled, so the task waits for it even while quota is left. Unknown reset: it goes by quota alone.
        ...(task.dispatchTrigger === 'quota-reset' && Number.isFinite(Date.parse(task.notBefore || '')) ? { notBefore: new Date(task.notBefore).toISOString() } : {}),
        ...(recurrence ? { recurrence } : {}),
        status: 'pending',
        retryCount: 0,
        createdAt: new Date().toISOString(),
      };
      const firstInChat = isContinue(scheduled) ? this.tasks.findIndex(item => item.chatId === scheduled.chatId && item.status === 'pending') : -1;
      if (firstInChat >= 0) this.tasks.splice(firstInChat, 0, scheduled); else this.tasks.push(scheduled);
      await this.persist();
      return { ...scheduled, attachments: scheduled.attachments.map((attachment) => ({ ...attachment })) };
    });
  }

  async dequeue(taskIdValue) {
    return this.update(taskIdValue, (task) => { task.status = 'cancelled'; task.completedAt = new Date().toISOString(); });
  }

  // P16-K: array order *is* dispatch priority (FIFO until reordered), so
  // the queue manager's drag-and-drop reorder is what the watchdog runs.
  async getQueue() {
    await this.load();
    return this.tasks.map(copyTask);
  }

  /** Rewrites a still-pending task's prompt (the queue manager's inline edit). */
  async editPrompt(taskIdValue, prompt) {
    const text = String(prompt || '').trim();
    if (!text) throw new Error('Scheduled task prompt is required.');
    let edited = false;
    await this.update(taskIdValue, (task) => { if (task.status === 'pending') { task.prompt = text; edited = true; } });
    return edited;
  }

  /** Reorders the given tasks among the slots they already occupy; everything else stays put. */
  async reorder(orderedIds) {
    await this.load();
    return this.withWrite(async () => {
      const wanted = (Array.isArray(orderedIds) ? orderedIds : []).filter((id, i, all) => all.indexOf(id) === i);
      const moving = wanted.map((id) => this.tasks.find((task) => task.id === id)).filter(Boolean);
      if (moving.length < 2) return false;
      const slots = this.tasks.map((task, index) => (moving.includes(task) ? index : -1)).filter((index) => index >= 0);
      slots.forEach((slot, i) => { this.tasks[slot] = moving[i]; });
      await this.persist();
      return true;
    });
  }

  async getNextPendingForModel(model) {
    await this.load();
    if (!MODELS.has(model)) return null;
    const now = Date.now();
    const task = this.tasks.find((item) => item.status === 'pending' && item.model === model && isDue(item, now) && (!item.chatId || firstPrompt({}, this.tasks.filter(other => other.chatId === item.chatId))?.id === item.id));
    return task ? copyTask(task) : null;
  }

  async markDispatched(taskIdValue) {
    return this.update(taskIdValue, (task) => { task.status = 'dispatched'; task.dispatchedAt = new Date().toISOString(); task.error = undefined; });
  }

  /** P17-H: an interrupted (or failed) task goes back to 'pending' for the next quota reset or its fixed time. */
  async reschedule(taskIdValue) {
    let moved = false;
    await this.update(taskIdValue, (task) => {
      if (task.status !== 'interrupted' && task.status !== 'failed') return;
      task.status = 'pending'; task.retryCount = 0; moved = true;
      delete task.error; delete task.retryAfter; delete task.interruptedAt; delete task.interruptedReason; delete task.completedAt;
    });
    return moved;
  }

  async markCompleted(taskIdValue, outputPreview = '') {
    return this.update(taskIdValue, (task) => {
      task.status = 'done'; task.completedAt = new Date().toISOString(); task.outputPreview = String(outputPreview || '').slice(0, 800); task.error = undefined;
      if (task.recurrence) this.repeat(task);
    });
  }

  /**
   * A finished repeating task leaves a fresh pending copy one interval later, until the run limit or the expiry. Cancelling
   * that copy (or the chat's `/loop stop`) ends the loop, because nothing else makes the next one. Called inside a write.
   */
  repeat(task) {
    const { everyMinutes, maxRuns, expiresAt, run } = task.recurrence;
    const next = Date.now() + everyMinutes * 60000;
    const reason = task.recurrence.stopped ? 'was stopped' : run >= maxRuns ? `ran ${maxRuns} times` : next > Date.parse(expiresAt) ? 'reached its expiry' : '';
    if (reason) { task.recurrence = { ...task.recurrence, ended: reason }; return; }
    const { id: _id, status: _status, completedAt: _completedAt, outputPreview: _preview, error: _error, dispatchedAt: _dispatchedAt, retryAfter: _retryAfter, interruptedAt: _interruptedAt, interruptedReason: _interruptedReason, ...rest } = task;
    this.tasks.push({ ...rest, id: taskId(), attachments: [], dispatchTime: new Date(next).toISOString(), recurrence: { everyMinutes, maxRuns, expiresAt, run: run + 1 }, status: 'pending', retryCount: 0, createdAt: new Date().toISOString() });
  }

  /** `/loop stop`: cancels the chat's waiting repeats. Returns how many there were. */
  async stopRepeating(chatId) {
    await this.load();
    let stopped = 0;
    await this.withWrite(async () => {
      for (const task of this.tasks) {
        if (task.chatId !== chatId || !task.recurrence || !ACTIVE.has(task.status)) continue;
        if (task.status === 'dispatched') task.recurrence = { ...task.recurrence, stopped: true }; // the run in flight finishes, but leaves no next one
        else { task.status = 'cancelled'; task.completedAt = new Date().toISOString(); }
        stopped++;
      }
      if (stopped) await this.persist();
    });
    return stopped;
  }

  async markFailed(taskIdValue, error) {
    return this.update(taskIdValue, (task) => {
      task.retryCount = Math.min(3, Number(task.retryCount || 0) + 1);
      task.error = String(error || 'Unknown scheduler error').slice(0, 1000);
      if (task.retryCount >= 3) {
        task.status = 'failed';
        task.completedAt = new Date().toISOString();
      } else {
        task.status = 'pending';
        task.retryAfter = new Date(Date.now() + RETRY_BACKOFF_MS * 4 ** (task.retryCount - 1)).toISOString(); // 1 min, then 4 min
      }
    });
  }

  async cleanupTask(taskIdValue) {
    await this.load();
    return this.withWrite(async () => {
      const index = this.tasks.findIndex((task) => task.id === taskIdValue);
      if (index < 0) return false;
      this.tasks.splice(index, 1);
      await fs.rm(path.join(this.stagingDir, taskIdValue), { recursive: true, force: true });
      await this.persist();
      return true;
    });
  }

  async stageAttachments(rawAttachments, targetDir) {
    if (!Array.isArray(rawAttachments) || rawAttachments.length === 0) return [];
    await fs.mkdir(targetDir, { recursive: true });
    const result = [];
    try {
      for (const source of rawAttachments) {
        const sourcePath = path.resolve(String(source));
        const stat = await fs.stat(sourcePath);
        if (!stat.isFile()) throw new Error(`Attachment is not a file: ${sourcePath}`);
        if (stat.size >= MAX_ATTACHMENT_BYTES) throw new Error(`Attachment ${path.basename(sourcePath)} must be smaller than 20 MB.`);
        let name = safeName(path.basename(sourcePath));
        let destination = path.join(targetDir, name);
        let suffix = 1;
        while (await exists(destination)) {
          name = `${suffix++}_${safeName(path.basename(sourcePath))}`;
          destination = path.join(targetDir, name);
        }
        await fs.copyFile(sourcePath, destination);
        const { readMarkup, writeMarkup } = require('./markup');
        const markup = readMarkup(sourcePath);
        if (markup) {
          const original = path.join(targetDir, `${name}.original${path.extname(markup.original)}`);
          await fs.copyFile(markup.original, original);
          writeMarkup(destination, original, markup);
        }
        result.push({ name, size: stat.size, relativePath: path.relative(this.workspaceDir, destination).split(path.sep).join('/'), absolutePath: destination, mimeType: mimeFor(name) });
      }
      return result;
    } catch (error) {
      await fs.rm(path.dirname(targetDir), { recursive: true, force: true });
      throw error;
    }
  }

  async update(taskIdValue, mutate) {
    await this.load();
    return this.withWrite(async () => {
      const task = this.tasks.find((item) => item.id === taskIdValue);
      if (!task) return false;
      await mutate(task);
      await this.persist();
      return true;
    });
  }
  async saveDraft(id, turn, files, editing, { clearReset = false, schedule = null } = {}) {
    return this.update(id, async task => {
      if (task.status !== 'pending') return;
      // Stage into a fresh folder before replacing the original attachment list.
      const signature = JSON.stringify(files);
      const attachments = this.draftFiles.get(id) === signature ? task.attachments
        : await this.stageAttachments(files, path.join(this.stagingDir, id, crypto.randomUUID(), 'attachments'));
      this.draftFiles.set(id, signature);
      task.prompt = String(turn?.text || '');
      task.attachments = attachments;
      const previousModelId = task.modelId;
      if (turn?.modelId && turn.modelId !== 'auto') task.modelId = String(turn.modelId);
      const model = require('./model-catalog').modelOption(task.modelId)?.agent;
      if (MODELS.has(model)) {
        const modelChanged = Boolean(previousModelId && task.modelId !== previousModelId);
        // Antigravity models span separate quota pools and individual model caps, so switching to another Antigravity model drops the old reset wait too.
        if (!schedule && task.dispatchTrigger === 'quota-reset' && (clearReset || model !== task.model || (model === 'gemini' && modelChanged))) {
          // A reset deadline belongs to the exhausted provider (or Antigravity model), not the prompt.
          task.dispatchTrigger = 'fixed-time';
          task.dispatchTime = new Date().toISOString();
          delete task.notBefore;
          delete task.resetWindow;
          delete task.retryAfter;
        }
        task.model = model;
      }
      if (!editing && schedule) {
        if (schedule.dispatchTrigger === 'fixed-time' && Number.isFinite(Date.parse(schedule.dispatchTime || ''))) {
          task.dispatchTrigger = 'fixed-time';
          task.dispatchTime = new Date(schedule.dispatchTime).toISOString();
          delete task.resetWindow; delete task.notBefore; delete task.retryAfter;
        } else if (schedule.dispatchTrigger === 'quota-reset') {
          task.dispatchTrigger = 'quota-reset';
          if (schedule.resetWindow === '7d') task.resetWindow = '7d'; else delete task.resetWindow;
          if (Number.isFinite(Date.parse(schedule.notBefore || ''))) task.notBefore = new Date(schedule.notBefore).toISOString(); else delete task.notBefore;
          delete task.dispatchTime; delete task.retryAfter;
        }
      }
      task.editing = editing === true;
    });
  }

  async withWrite(operation) {
    const next = this.writeTail.then(operation, operation);
    this.writeTail = next.catch(() => {});
    return next;
  }

  async persist() {
    alignClaudeResets(this.tasks);
    await fs.mkdir(this.sessionDir, { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(this.tasks, null, 2), 'utf8');
    // Windows refuses the rename (EPERM/EBUSY) while an indexer, antivirus or sync client holds the target: retry, then write in place.
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(temporary, this.filePath); break; } catch (error) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) { await fs.rm(temporary, { force: true }).catch(() => {}); throw error; }
        if (attempt < 4) { await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1))); continue; }
        try { await fs.writeFile(this.filePath, JSON.stringify(this.tasks, null, 2), 'utf8'); } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
        break;
      }
    }
    this.syncAwake();
  }

  syncAwake() {
    const needed = !this.disposed && this.tasks.some(task => ['pending', 'dispatched'].includes(task.status));
    if (needed && !this.awake && this.keepAwake) this.awake = this.keepAwake();
    else if (!needed && this.awake) { this.awake.release(); this.awake = null; }
  }

  dispose() { this.disposed = true; this.syncAwake(); }
}

// Claude's /usage and cached reset readings can disagree by one minute. Keep one conservative deadline per batch.
function alignClaudeResets(tasks) {
  const groups = new Map();
  for (const task of tasks) {
    if (task.model !== 'claude' || task.status !== 'pending' || task.dispatchTrigger !== 'quota-reset' || !Number.isFinite(Date.parse(task.notBefore))) continue;
    const key = JSON.stringify([task.chatId, task.resetWindow || '5h']);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(task);
  }
  let changed = false;
  for (const group of groups.values()) {
    group.sort((a, b) => Date.parse(a.notBefore) - Date.parse(b.notBefore));
    for (let start = 0; start < group.length;) {
      let end = start + 1;
      while (end < group.length && Date.parse(group[end].notBefore) - Date.parse(group[start].notBefore) <= 60000) end++;
      const deadline = group[end - 1].notBefore;
      for (let i = start; i < end; i++) if (Date.parse(group[i].notBefore) !== Date.parse(deadline)) { group[i].notBefore = deadline; changed = true; }
      start = end;
    }
  }
  return changed;
}
function copyTask(task) { return { ...task, attachments: task.attachments.map((attachment) => ({ ...attachment })) }; }
function isContinue(task) { return Boolean(task?.chatId) && /^\s*continue\s*[.!]?\s*$/i.test(task.prompt); }
function isDue(task, now) {
  if (task.editing || !String(task.prompt || '').trim()) return false;
  if (task.notBefore && Date.parse(task.notBefore) > now) return false;
  if (task.retryAfter && Date.parse(task.retryAfter) > now) return false; // backoff after a failed attempt
  return task.dispatchTrigger !== 'fixed-time' || Date.parse(task.dispatchTime) <= now;
}
const RESET_SLACK_MS = 2 * 60 * 1000; // a provider's reset clock and the notice's own minute can disagree a little
/**
 * A "when usage resets" task waits for the reset time it was scheduled against, but the window can end early: a manual reset,
 * or one the provider hands out. That shows as the model's window now ending after the task's saved time (a new window began),
 * or as a fresh undated window; either way with usage left and no other limit (the week) still holding.
 */
function resetObserved(task, quota, now = Date.now()) {
  if (task?.dispatchTrigger !== 'quota-reset' || !(Date.parse(task.notBefore) > now)) return false;
  const window = task.resetWindow === '7d' ? quota?.secondary : quota;
  if (typeof window?.remaining !== 'number' || window.remaining <= 0 || quota?.secondary?.remaining === 0) return false;
  if (typeof window.resetsAt === 'number') return window.resetsAt * 1000 > Date.parse(task.notBefore) + RESET_SLACK_MS;
  return window.remaining >= 99; // "0% used" right after a reset, before the next window has a time
}
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
function mimeFor(name) {
  const ext = path.extname(name).toLowerCase();
  return ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.json': 'application/json', '.md': 'text/markdown', '.txt': 'text/plain' })[ext] || 'application/octet-stream';
}

// Same stable ordering as the mixed strip: saved ranks, then scheduled prompts, then queued turns.
function firstPrompt(state = {}, tasks = []) {
  const rank = new Map((state.order || []).map((key, i) => [key.slice(key.indexOf(':') + 1), i]));
  return [...tasks.filter(task => task.status === 'pending'), ...(state.turns || [])]
    .sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9))[0];
}

module.exports = { SchedulerQueue, normalizeRecurrence, isDue, resetObserved, firstPrompt, MAX_QUEUE_SIZE, MAX_ATTACHMENT_BYTES, ACTIVE_STATUSES: [...ACTIVE] };
