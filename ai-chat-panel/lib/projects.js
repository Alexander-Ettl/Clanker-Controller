'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ICON_TYPES = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon' };
const ICON_LIMIT = 256 * 1024; // the rail ships the icon inside the 'project' message, so it stays small
const iconCache = new Map();

/** Where a project's icon file lives: an absolute path as saved, or one relative to the project folder. */
function iconFile(project, icon = project.icon) {
  if (!icon) return null;
  return path.isAbsolute(icon) ? icon : project.root ? path.join(project.root, icon) : null;
}

/** Throws a sentence the Settings popup can show when `file` is no usable icon. */
function checkIcon(file) {
  if (!file) throw new Error('Choose an absolute path, or a path inside a project that has a folder.');
  if (!ICON_TYPES[path.extname(file).toLowerCase()]) throw new Error('An icon is a PNG, SVG, ICO, JPG, WebP or GIF file.');
  let stat; try { stat = fs.statSync(file); } catch { throw new Error('That icon file does not exist.'); }
  if (!stat.isFile()) throw new Error('That icon is not a file.');
  if (stat.size > ICON_LIMIT) throw new Error(`Icons are limited to ${ICON_LIMIT / 1024} KB. Pick a smaller file.`);
  return stat;
}

/** The icon as a data: URI (the chat webview's CSP allows data: images), or null when unset or unreadable: the rail then shows initials. */
function iconDataUri(project) {
  try {
    const file = iconFile(project);
    if (!file) return null;
    const stat = checkIcon(file);
    const cached = iconCache.get(file);
    if (cached?.mtime === stat.mtimeMs) return cached.uri;
    const uri = `data:${ICON_TYPES[path.extname(file).toLowerCase()]};base64,${fs.readFileSync(file).toString('base64')}`;
    iconCache.set(file, { mtime: stat.mtimeMs, uri });
    return uri;
  } catch { return null; }
}

/** What the webviews get for each project. */
const describe = project => ({ id: project.id, name: project.name, root: project.root, icon: project.icon || '', iconUri: iconDataUri(project) });

/** The likeliest favicon or logo under a project folder (three levels deep): favicons first, then logos and icons, nearer the root wins. */
function findIcon(root) {
  const skip = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.astro', '.next', 'coverage', '.migration-backup', 'vendor']);
  let best = null, seen = 0;
  const walk = (directory, depth) => {
    let entries; try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (++seen > 4000) return;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { if (depth < 3 && !skip.has(entry.name)) walk(file, depth + 1); continue; }
      const extension = path.extname(entry.name).toLowerCase();
      if (!entry.isFile() || !ICON_TYPES[extension]) continue;
      const base = path.basename(entry.name, extension).toLowerCase();
      const kind = /^favicon/.test(base) ? 0 : /logo|icon/.test(base) ? 3 : -1;
      if (kind < 0) continue;
      try { if (fs.statSync(file).size > ICON_LIMIT) continue; } catch { continue; }
      const score = depth * 2 + kind + (extension === '.svg' ? 0 : extension === '.png' ? 0.2 : 0.4);
      if (!best || score < best.score) best = { file, score };
    }
  };
  walk(root, 0);
  return best?.file || null;
}

const canonical = folder => fs.realpathSync.native(path.resolve(folder));
/** `file` with its nearest existing parent resolved to the real path, so a file that does not exist yet still matches. */
function realPath(file) {
  let current = path.resolve(file), tail = '';
  for (;;) {
    try { return path.join(fs.realpathSync.native(current), tail); } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(file);
      tail = path.join(path.basename(current), tail); current = parent;
    }
  }
}
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
    if (changes.icon !== undefined) {
      const icon = String(changes.icon || '').trim();
      if (icon) { checkIcon(iconFile(project, icon)); project.icon = icon; } else delete project.icon;
    }
    if (changes.name) project.name = String(changes.name).trim().slice(0, 120);
    this.write(items); return project;
  }
  /** Unregisters a project. Its folder and the chats bound to it stay untouched. */
  remove(id) {
    const items = this.list(), at = items.findIndex(item => item.id === id);
    if (at < 0) throw new Error('Project not found.');
    const [project] = items.splice(at, 1);
    this.write(items); return project;
  }
  /** The project whose folder holds `file`. Roots are stored resolved, so a path that reaches them another way (8.3 short names, junctions, a subst drive) is resolved once if the plain match fails. */
  forFile(file) {
    if (!file) return null;
    const items = this.list().filter(item => item.root);
    const find = path_ => {
      const target = key(path_);
      return items.filter(item => target === key(item.root) || target.startsWith(key(item.root + path.sep)))
        .sort((a, b) => b.root.length - a.root.length)[0] || null;
    };
    return find(path.resolve(file)) || find(realPath(file));
  }
  /** A file-to-project-id lookup over one snapshot of the registry, for classifying many files at once. */
  resolver() {
    const roots = this.list().filter(item => item.root).map(item => ({ id: item.id, root: key(item.root) }))
      .sort((a, b) => b.root.length - a.root.length);
    return file => {
      if (!path.isAbsolute(file)) return null;
      const target = key(path.resolve(file));
      return roots.find(item => target === item.root || target.startsWith(item.root + path.sep))?.id || null;
    };
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

module.exports = { ProjectRegistry, projectFiles, describe, findIcon, realPath };
