'use strict';

// The provider registry: every coding-agent CLI Clanker can drive is one descriptor here, and the rest of the extension
// (finding the binary, versions and updates, sign-in, model discovery, the webviews' names, colours and logos) reads
// this list instead of naming claude, codex or gemini itself. Adding a provider means adding a descriptor (see
// docs/adding-a-provider.md); `register()` also takes one at run time.
//
// A descriptor:
//   id            short, lower case, [a-z0-9-]; the `agent` value on chats, models and messages
//   name          shown in the UI                         accountName   longer name where it helps (setup terminal title)
//   company       who makes the models                    color         '#rrggbb', the provider's accent
//   cli           the command a person types              icon          optional SVG string; a monogram is drawn without one
//   headlessApprovals  false when it cannot ask for approval run headless (default true)
//   locate(h)     candidate paths for the binary, best first; h = { onPath, inExtensions, join, home, local, npmGlobal }
//   npmPackage    latest version comes from the npm registry   latestVersion(fetch)  or from here (null = unknown)
//   updateArgs    default ['update']                      versionArgs   default ['--version']
//   login         args that start sign-in                 install       PowerShell line that installs the CLI and signs in
//   authStatus    { args, interpret(result) -> 'connected' | 'ready' | 'signin' | 'broken' (CLI cannot start) }
//   entitlement   optional ({ result, home, env, languageServer }) -> null | { kind: 'plan', reason, detail } (may be async; null = fine, undefined = cannot tell, the last verdict stands); run after each sign-in check
//                 that says connected. Say so here when the CLI stays "signed in" after the plan that unlocks it ends.
//   discoverModels({ file, runCli })  raw model entries ({ id, agent, model, effort, label, isDefault }) or null on failure
// What a descriptor does not cover yet is running a chat: lib/stream-engine.js still builds each provider's command and
// reads its output (the "runner"), see the guide.

const BUILTIN = [require('./claude.js'), require('./codex.js'), require('./gemini.js')];
const providers = new Map();

const COLOR = /^#[0-9a-f]{6}$/i;

/** The descriptor's problems as sentences; empty when it is fit to register. */
function validate(provider) {
  const problems = [];
  if (!provider || typeof provider !== 'object') return ['a provider is an object'];
  if (!/^[a-z0-9-]+$/.test(provider.id || '')) problems.push('id must be lower case letters, digits and dashes');
  for (const field of ['name', 'company', 'cli']) if (!provider[field] || typeof provider[field] !== 'string') problems.push(`${field} is required`);
  if (!COLOR.test(provider.color || '')) problems.push('color must be #rrggbb');
  if (typeof provider.locate !== 'function') problems.push('locate(helpers) is required');
  if (!Array.isArray(provider.login)) problems.push('login must be an array of arguments');
  if (!provider.authStatus || !Array.isArray(provider.authStatus.args) || typeof provider.authStatus.interpret !== 'function') problems.push('authStatus needs args and interpret()');
  if (typeof provider.install !== 'string') problems.push('install is required');
  if (typeof provider.discoverModels !== 'function') problems.push('discoverModels({ file, runCli }) is required');
  if (!provider.npmPackage && typeof provider.latestVersion !== 'function') problems.push('npmPackage or latestVersion(fetch) is required');
  return problems;
}

/** Adds (or replaces) a provider. Throws with every problem at once when the descriptor is not valid. */
function register(provider) {
  const problems = validate(provider);
  if (problems.length) throw new Error(`Provider "${provider?.id ?? '?'}": ${problems.join('; ')}`);
  providers.set(provider.id, { updateArgs: ['update'], versionArgs: ['--version'], accountName: provider.name, ...provider });
  return providers.get(provider.id);
}

function unregister(id) { return providers.delete(id); }

const has = (id) => providers.has(id);
const get = (id) => providers.get(id) || null;
const all = () => [...providers.values()];
const ids = () => [...providers.keys()];

/** What the webviews need: no functions, nothing about the machine. */
const displayList = () => all().map(({ id, name, accountName, company, color, cli, icon, headlessApprovals }) => ({ id, name, accountName, company, color, cli, headlessApprovals: headlessApprovals !== false, ...(icon ? { icon } : {}) }));

/** The accent rules a provider needs in the webviews (the built-in ones also sit in style.css; the same rule twice is harmless). */
function accentCss(list = displayList()) {
  return list.map(({ id, color }) => [
    `:root { --${id}-color: ${color}; }`,
    `[data-agent='${id}'] { --agent: var(--${id}-color); }`,
    `.dot-${id} { background: var(--${id}-color); }`,
    `[data-agent='${id}'] > .model-picker-icon, [data-agent='${id}'] > .model-option-icon, .model-pill[data-brand='${id}'] { color: var(--${id}-color); }`,
    `.model-card-${id} { --agent: var(--${id}-color); }`,
  ].join('\n')).join('\n');
}

BUILTIN.forEach(register);

module.exports = { register, unregister, validate, has, get, all, ids, displayList, accentCss };
