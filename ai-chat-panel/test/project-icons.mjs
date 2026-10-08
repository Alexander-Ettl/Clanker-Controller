import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const { ProjectRegistry, describe, findIcon } = createRequire(import.meta.url)('../lib/projects.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'project-icons-'));
try {
  const root = path.join(tmp, 'site');
  const write = (file, text = '<svg xmlns="http://www.w3.org/2000/svg"/>') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
  const favicon = write(path.join(root, 'public', 'favicon.svg'));
  write(path.join(root, 'brand-logo.svg'));
  write(path.join(root, 'node_modules', 'dep', 'favicon.ico'));
  write(path.join(root, 'huge-icon.png', '..', 'icon.png'), 'x'.repeat(300 * 1024));
  assert.equal(findIcon(root), favicon, 'a favicon beats a logo, and node_modules is skipped');
  assert.equal(findIcon(path.join(tmp, 'empty')), null);

  const registry = new ProjectRegistry(path.join(tmp, 'session'));
  const project = registry.add('Site', root);
  assert.equal(describe(project).iconUri, null, 'no icon: the rail falls back to the initials');

  registry.update(project.id, { icon: favicon });
  const uri = describe(registry.get(project.id)).iconUri;
  assert.match(uri, /^data:image\/svg\+xml;base64,/);
  registry.update(project.id, { icon: 'brand-logo.svg' });
  assert.equal(registry.get(project.id).icon, 'brand-logo.svg', 'a path inside the project folder is kept relative');
  assert.match(describe(registry.get(project.id)).iconUri, /^data:image\/svg\+xml/);

  assert.throws(() => registry.update(project.id, { icon: path.join(root, 'icon.png') }), /limited to 256 KB/);
  assert.throws(() => registry.update(project.id, { icon: path.join(root, 'missing.svg') }), /does not exist/);
  assert.throws(() => registry.update(project.id, { icon: path.join(root, 'notes.txt') }), /PNG, SVG/);
  assert.equal(registry.get(project.id).icon, 'brand-logo.svg', 'a refused icon changes nothing');

  fs.rmSync(path.join(root, 'brand-logo.svg'));
  assert.equal(describe(registry.get(project.id)).iconUri, null, 'an icon that vanished falls back to the initials');
  registry.update(project.id, { icon: '' });
  assert.equal('icon' in registry.get(project.id), false, 'clearing removes the field');
  console.log('project icons ok');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
