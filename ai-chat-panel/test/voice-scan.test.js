'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanProject } = require('../lib/voice-scan');

const project = (files) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-scan-'));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  }
  return root;
};

test('a scan finds the project name, packages and its own identifiers, not ordinary words or API calls', async () => {
  const root = project({
    'package.json': JSON.stringify({ name: 'visor-app', dependencies: { astro: '^5', '@astrojs/tailwind': '^6', 'left-pad': '1' } }),
    'src/PlantSimulator.ts': 'export class PlantSimulator { runTick() { document.getElementById("x").addEventListener("click", handleBufferDeadlock); } }\nfunction handleBufferDeadlock() {}',
    'src/other.js': 'import { PlantSimulator } from "./PlantSimulator"; const sim = new PlantSimulator(); handleBufferDeadlock(sim); oneOffLocalName();',
    'node_modules/dep/index.js': 'class ShouldNeverAppear {} ShouldNeverAppear; ShouldNeverAppear;',
    '.env': 'SecretToken=abc',
  });
  try {
    const { terms, stats } = await scanProject(root, { name: 'Visor' });
    assert.equal(terms[0], 'Visor');
    for (const wanted of ['astro', 'astrojs', 'tailwind', 'PlantSimulator', 'handleBufferDeadlock']) assert.ok(terms.includes(wanted), `${wanted} in ${terms}`);
    for (const unwanted of ['getElementById', 'addEventListener', 'ShouldNeverAppear', 'oneOffLocalName', 'SecretToken', 'left']) assert.ok(!terms.includes(unwanted), `${unwanted} not in ${terms}`);
    assert.equal(stats.truncated, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a scan stops at its limits on a big project', async () => {
  const files = {};
  for (let index = 0; index < 40; index++) files[`src/file${index}.js`] = `class SharedWidgetThing {}\nSharedWidgetThing; helperThing${index}Value();\n`;
  const root = project(files);
  try {
    const capped = await scanProject(root, { limits: { files: 10, terms: 5 } });
    assert.equal(capped.stats.truncated, true);
    assert.ok(capped.stats.files <= 10);
    assert.ok(capped.terms.length <= 5);
    assert.ok(capped.terms.includes('SharedWidgetThing'));
    assert.equal((await scanProject(root, { limits: { fileBytes: 10 } })).stats.files, 0, 'files over the size cap are skipped');
    assert.deepEqual((await scanProject(path.join(root, 'missing'))).terms, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
