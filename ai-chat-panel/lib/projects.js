'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const canonical = folder => fs.realpathSync.native(path.resolve(folder));
const key = folder => process.platform === 'win32' ? folder.toLowerCase() : folder;

// User-local identities survive folder moves. No project code or history is stored in this registry.
class ProjectRegistry {
  constructor(sessionDir) {
    this.sessionDir = sessionDir;
    this.file = path.join(sessionDir, 'projects.json');
  }
  list() {
    if (!fs.existsSync(this.file)) return [];
    const items = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (!Array.isArray(items)) throw new Error('Clanker project registry is invalid.');
    return items;
  }
  get(id) { return this.list().find(project => project.id === id) || null; }
  write(items) {
    fs.mkdirSync(this.sessionDir, { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    if (fs.existsSync(this.file)) fs.copyFileSync(this.file, `${this.file}.bak`);
    fs.writeFileSync(temporary, JSON.stringify(items, null, 2), 'utf8');
    JSON.parse(fs.readFileSync(temporary, 'utf8'));
    fs.renameSync(temporary, this.file);
  }
  add(name, folder = null) {
    const root = folder ? canonical(folder) : null;
    if (root && !fs.statSync(root).isDirectory()) throw new Error('Choose a project folder.');
    const items = this.list();
    const existing = root && items.find(item => item.root && key(item.root) === key(root));
    if (existing) return existing;
    const project = { id: crypto.randomUUID(), name: String(name || (root && path.basename(root)) || 'Planning').trim().slice(0, 120), root };
    items.push(project); this.write(items);
    return project;
  }
  update(id, changes) {
    const items = this.list(), project = items.find(item => item.id === id);
    if (!project) throw new Error('Project not found.');
    if (changes.root !== undefined) {
      const root = canonical(changes.root);
      if (!fs.statSync(root).isDirectory()) throw new Error('Choose a project folder.');
      if (items.some(item => item.id !== id && item.root && key(item.root) === key(root))) throw new Error('This folder already belongs to another project.');
      project.root = root;
    }
    if (changes.name) project.name = String(changes.name).trim().slice(0, 120);
    this.write(items); return project;
  }
  forFile(file) {
    if (!file) return null;
    const target = key(path.resolve(file));
    return this.list().filter(item => item.root && (target === key(item.root) || target.startsWith(key(item.root + path.sep))))
      .sort((a, b) => b.root.length - a.root.length)[0] || null;
  }
  context(id, { allowMissing = false } = {}) {
    const project = this.get(id);
    if (!project && !allowMissing) throw new Error('Choose a project in the chat before sending a message.');
    const sessionDir = path.join(this.sessionDir, 'projects', project?.id || 'unassigned');
    const attachmentsDir = path.join(sessionDir, 'attachments');
    fs.mkdirSync(attachmentsDir, { recursive: true });
    const workspaceDir = project?.root || path.join(sessionDir, 'planning');
    if (!project?.root) fs.mkdirSync(workspaceDir, { recursive: true });
    if (project?.root && !fs.existsSync(workspaceDir) && !allowMissing) throw new Error(`The folder for ${project.name} is unavailable. Locate it using Manage projects before running this chat.`);
    return { project, sessionDir, attachmentsDir, workspaceDir };
  }
}

// Registered folders can be outside the VS Code Explorer/workspace. Walk only this root, never symlinks.
async function projectFiles(root, limit = 5000) {
  const files = [], pending = [''];
  const excluded = new Set(['.git', 'node_modules', '.astro', '.next', 'dist', 'out', 'build', 'coverage']);
  while (pending.length && files.length < limit) {
    const relative = pending.pop();
    try {
      const directory = await fs.promises.opendir(path.join(root, relative));
      for await (const entry of directory) {
        if (entry.name.startsWith('.') && excluded.has(entry.name)) continue;
        const target = path.join(relative, entry.name);
        if (entry.isDirectory() && !excluded.has(entry.name)) pending.push(target);
        else if (entry.isFile()) files.push(target.split(path.sep).join('/'));
        if (files.length >= limit) break;
      }
    } catch { /* An unavailable directory is left out of the mention picker. */ }
  }
  return files.sort();
}

module.exports = { ProjectRegistry, projectFiles };
