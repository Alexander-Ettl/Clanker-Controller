'use strict';

// What kind of project is this, how is it checked, and can it be looked at in a browser? Detection only reads files:
// it never runs project code. The checks it lists are run later in the loop's private copy.

const fs = require('node:fs');
const path = require('node:path');
const { nodeCommand, npmCommand } = require('./loop-exec');

const exists = (root, ...parts) => fs.existsSync(path.join(root, ...parts));
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const listDir = dir => { try { return fs.readdirSync(dir); } catch { return []; } };
const any = (root, pattern) => listDir(root).some(name => pattern.test(name));
const SCRIPT_NAME = /^[\w:.-]{1,60}$/;
const STUB_TEST = /no test specified/i;

/** A check is { name, command, args, env, timeoutMs, gate? }. `gate` marks the quick ones also used to guard each single fix. */
function npmScript(root, name, timeoutMs, extra = {}) {
  const npm = npmCommand();
  if (!npm || !SCRIPT_NAME.test(name)) return null;
  return { name, command: npm.command, args: [...npm.args, 'run', '--silent', name], env: { ...npm.env, CI: '1', FORCE_COLOR: '0' }, timeoutMs, ...extra };
}

function nodeChecks(root, pkg) {
  const scripts = pkg.scripts || {};
  const checks = [];
  const first = names => names.find(name => scripts[name]);
  const quick = first(['typecheck', 'check', 'lint', 'verify:quick']);
  if (quick) checks.push(npmScript(root, quick, 5 * 60000, { gate: true }));
  const test = first(['test', 'test:unit', 'verify']);
  if (test && !STUB_TEST.test(scripts[test])) checks.push(npmScript(root, test, 15 * 60000));
  if (scripts.build && !/^(astro|vite|next)? ?dev/.test(scripts.build)) checks.push(npmScript(root, 'build', 10 * 60000, { optional: true }));
  return checks.filter(Boolean);
}

function webTarget(root, pkg) {
  const scripts = pkg?.scripts || {};
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const script = ['dev', 'start', 'serve', 'preview'].find(name => scripts[name]);
  const framework = deps.astro ? 'astro' : deps.next ? 'next' : deps.vite ? 'vite' : deps.nuxt ? 'nuxt' : deps['@sveltejs/kit'] ? 'sveltekit' : deps['react-scripts'] ? 'cra' : null;
  const html = exists(root, 'index.html') || exists(root, 'public', 'index.html') || exists(root, 'dist', 'index.html') || exists(root, 'build', 'index.html');
  if (script) return { framework, script, static: null };
  if (html) return { framework, script: null, static: ['dist', 'build', 'public', '.'].find(dir => exists(root, dir, 'index.html')) || '.' };
  return null;
}

/** Visor wires a dev-only editor into Astro sites; its config files mark such a site. */
const hasVisor = root => exists(root, 'astro-visual-editor.config.json') || exists(root, 'visual-editor.mjs') || exists(root, '.visual-editor');

function detectProfile(root) {
  const pkg = readJson(path.join(root, 'package.json'));
  const base = { root, kind: 'generic', label: 'Project', checks: [], web: null, visor: hasVisor(root), ios: false, notes: [] };
  // Clanker Controller itself keeps its own syntax checker, test suite and fixture renderer.
  if (exists(root, 'ai-chat-panel', 'test', 'check.js')) {
    const node = nodeCommand();
    return { ...base, kind: 'clanker', label: 'Clanker Controller', clanker: true, checks: [
      { name: 'syntax', command: node.command, args: ['ai-chat-panel/test/check.js'], env: node.env, timeoutMs: 120000, gate: true },
      { name: 'tests', command: node.command, args: ['--test', 'ai-chat-panel/test/*.test.js', 'antigravity-usage-statusbar/test/usage.test.js'], env: node.env, timeoutMs: 600000 },
    ] };
  }
  if (pkg) {
    const web = webTarget(root, pkg);
    const kind = web?.framework || 'node';
    return { ...base, kind, label: pkg.name ? `${pkg.name} (${kind})` : `Node project (${kind})`, checks: nodeChecks(root, pkg), web };
  }
  if (exists(root, 'Package.swift') || any(root, /\.xcodeproj$|\.xcworkspace$/)) {
    const checks = process.platform === 'darwin' && exists(root, 'Package.swift')
      ? [{ name: 'swift build', command: 'swift', args: ['build'], timeoutMs: 15 * 60000, gate: true }, { name: 'swift test', command: 'swift', args: ['test'], timeoutMs: 20 * 60000 }] : [];
    return { ...base, kind: 'ios', ios: true, label: 'Swift / iOS project', checks,
      notes: [process.platform === 'darwin' ? 'Visual checks need an iOS simulator run; only the build and tests are automated.' : 'Swift builds need macOS, so this run reviews the code and cannot build or render it.'] };
  }
  if (exists(root, 'pyproject.toml') || exists(root, 'requirements.txt') || exists(root, 'setup.py')) {
    return { ...base, kind: 'python', label: 'Python project', checks: [{ name: 'compile', command: 'python', args: ['-m', 'compileall', '-q', '.'], timeoutMs: 120000, gate: true },
      ...(exists(root, 'tests') || exists(root, 'test') ? [{ name: 'tests', command: 'python', args: ['-m', 'pytest', '-q', '-x'], timeoutMs: 15 * 60000, optional: true }] : [])] };
  }
  if (exists(root, 'Cargo.toml')) return { ...base, kind: 'rust', label: 'Rust project', checks: [{ name: 'cargo check', command: 'cargo', args: ['check', '--quiet'], timeoutMs: 15 * 60000, gate: true }, { name: 'cargo test', command: 'cargo', args: ['test', '--quiet'], timeoutMs: 20 * 60000 }] };
  if (exists(root, 'go.mod')) return { ...base, kind: 'go', label: 'Go project', checks: [{ name: 'go vet', command: 'go', args: ['vet', './...'], timeoutMs: 10 * 60000, gate: true }, { name: 'go test', command: 'go', args: ['test', './...'], timeoutMs: 15 * 60000 }] };
  if (any(root, /\.sln$|\.csproj$/)) return { ...base, kind: 'dotnet', label: '.NET project', checks: [{ name: 'dotnet build', command: 'dotnet', args: ['build', '--nologo', '-v', 'q'], timeoutMs: 15 * 60000, gate: true }, { name: 'dotnet test', command: 'dotnet', args: ['test', '--nologo', '-v', 'q'], timeoutMs: 20 * 60000 }] };
  const web = webTarget(root, null);
  if (web) return { ...base, kind: 'static', label: 'Static site', web };
  return base;
}

/** True when the profile has anything a browser could show. */
const hasWebTarget = profile => Boolean(profile.web) || profile.clanker === true;

module.exports = { detectProfile, hasWebTarget, hasVisor, webTarget };
