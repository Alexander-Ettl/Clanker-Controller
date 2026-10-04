'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const providers = require('./providers');

const MAX_QUEUE_SIZE = 50;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MODELS = { has: (agent) => providers.has(agent) }; // any registered provider (lib/providers)
// Statuses still shown in the Scheduled tab and counted against MAX_QUEUE_SIZE.
const ACTIVE = new Set(['pending', 'dispatched', 'interrupted']);

function taskId() {
  return `sched_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
}

function safeName(name) {
  return path.basename(String(name || 'attachment.bin')).replace(/[^a-zA-Z0-9._-]/g, '_');
}

/** A small, disk-backed FIFO queue.  Attachments are copied before the task is
 * made visible, so a queued task never relies on a browser-temp file. */
class SchedulerQueue {
  constructor({ workspaceDir = process.cwd(), sessionDir } = {}) {
    this.workspaceDir = path.resolve(workspaceDir);
    this.sessionDir = path.resolve(sessionDir || path.join(this.workspaceDir, '.clanker', 'session'));
    this.filePath = path.join(this.sessionDir, 'scheduler-queue.json');
    this.stagingDir = path.join(this.sessionDir, 'scheduler');
    this.tasks = [];
    this.loaded = false;
    this.writeTail = Promise.resolve();
    this.draftFiles = new Map();
  }

  async load() {
    if (this.loaded) return;
    await fs.mkdir(this.sessionDir, { recursive: true });
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
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
        const inside = (root) => absolute.startsWith(root + path.sep);
        if (!(inside(this.workspaceDir) || inside(this.stagingDir)) || !(await exists(absolute))) {
          task.status = 'attachment-missing';
          changed = true;
          break;
        }
      }
    }
    if (changed) await this.persist();
  }

  async enqueue(task, rawAttachments = []) {
    await this.load();
    return this.withWrite(async () => {
      const active = this.tasks.filter((item) => ACTIVE.has(item.status));
      if (active.length >= MAX_QUEUE_SIZE) throw new Error(`Scheduler queue is full (maximum ${MAX_QUEUE_SIZE} active tasks).`);
      if (!MODELS.has(task?.model)) throw new Error(`Scheduled task must target ${providers.ids().join(', ')}.`);
      if (!String(task?.prompt || '').trim()) throw new Error('Scheduled task prompt is required.');
      if (!['quota-reset', 'fixed-time'].includes(task?.dispatchTrigger)) throw new Error('Scheduled task has an invalid dispatch trigger.');
      if (task.dispatchTrigger === 'fixed-time' && Number.isNaN(Date.parse(task.dispatchTime || ''))) throw new Error('Fixed-time tasks require an ISO dispatchTime.');

      const id = taskId();
      const attachmentDir = path.join(this.stagingDir, id, 'attachments');
      const attachments = await this.stageAttachments(rawAttachments, attachmentDir);
      const scheduled = {
        id,
        model: task.model,
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
        status: 'pending',
        retryCount: 0,
        createdAt: new Date().toISOString(),
      };
      this.tasks.push(scheduled);
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
    const task = this.tasks.find((item) => item.status === 'pending' && item.model === model && isDue(item, now));
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
      delete task.error; delete task.interruptedAt; delete task.interruptedReason; delete task.completedAt;
    });
    return moved;
  }

  async markCompleted(taskIdValue, outputPreview = '') {
    return this.update(taskIdValue, (task) => { task.status = 'done'; task.completedAt = new Date().toISOString(); task.outputPreview = String(outputPreview || '').slice(0, 800); task.error = undefined; });
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
  async saveDraft(id, turn, files, editing) {
    return this.update(id, async task => {
      if (task.status !== 'pending') return;
      // Stage into a fresh folder before replacing the original attachment list.
      const signature = JSON.stringify(files);
      const attachments = this.draftFiles.get(id) === signature ? task.attachments
        : await this.stageAttachments(files, path.join(this.stagingDir, id, crypto.randomUUID(), 'attachments'));
      this.draftFiles.set(id, signature);
      task.prompt = String(turn?.text || '');
      task.attachments = attachments;
      if (turn?.modelId && turn.modelId !== 'auto') task.modelId = String(turn.modelId);
      const model = require('./model-catalog').modelOption(task.modelId)?.agent;
      if (MODELS.has(model)) task.model = model;
      task.editing = editing === true;
    });
  }

  async withWrite(operation) {
    const next = this.writeTail.then(operation, operation);
    this.writeTail = next.catch(() => {});
    return next;
  }

  async persist() {
    await fs.mkdir(this.sessionDir, { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(this.tasks, null, 2), 'utf8');
    await fs.rename(temporary, this.filePath);
  }
}

function copyTask(task) { return { ...task, attachments: task.attachments.map((attachment) => ({ ...attachment })) }; }
function isDue(task, now) {
  if (task.editing || !String(task.prompt || '').trim()) return false;
  if (task.notBefore && Date.parse(task.notBefore) > now) return false;
  return task.dispatchTrigger !== 'fixed-time' || Date.parse(task.dispatchTime) <= now;
}
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
function mimeFor(name) {
  const ext = path.extname(name).toLowerCase();
  return ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.json': 'application/json', '.md': 'text/markdown', '.txt': 'text/plain' })[ext] || 'application/octet-stream';
}

module.exports = { SchedulerQueue, isDue, MAX_QUEUE_SIZE, MAX_ATTACHMENT_BYTES, ACTIVE_STATUSES: [...ACTIVE] };
