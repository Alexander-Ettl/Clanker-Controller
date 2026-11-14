// Tests the interface tester's deterministic layer against small pages that are broken (or not) on purpose.
// Run: node ai-chat-panel/test/ui-tester.mjs      No model, no CLI.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTester } from './ui-tester/run.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-ui-tester-test-'));
let counter = 0;
const run = (scenarios, options = {}) => runTester({ scenarios, outDir: path.join(tmp, `out-${++counter}`), baselineDir: path.join(tmp, 'baseline'), widths: [400], ...options });
const kinds = (report, id) => report.states.find(state => state.id === id).findings.map(item => item.kind);
const results = [];
const test = async (name, work) => { try { await work(); results.push(`ok   ${name}`); } catch (error) { results.push(`FAIL ${name}\n${error.stack}`); process.exitCode = 1; } };

const CLEAN = '<body style="margin:0;font:16px sans-serif"><main style="padding:16px"><h1>Settings</h1><p>Everything fits.</p><button>Save</button> <button>Cancel</button></main></body>';
const BROKEN = `<body style="margin:0;font:16px sans-serif">
  <div style="display:flex"><span id="a" style="width:120px;height:30px;background:#ccc">First</span><span id="b" style="width:120px;height:30px;margin-left:-60px;background:#999">Second</span></div>
  <button id="covered" style="margin:20px">Delete everything</button>
  <div style="position:fixed;left:0;top:50px;width:300px;height:60px;background:rgba(0,0,0,.5)"></div>
  <div id="clip" style="width:80px;overflow:hidden;white-space:nowrap">A sentence much too long for its box</div>
  <div style="width:2000px;height:4px;background:red"></div>
  <button id="icon" style="margin:20px"><svg width="20" height="20"><circle cx="10" cy="10" r="8"/></svg></button>
</body>`;
const LONG = '<body style="margin:0;font:16px monospace"><div style="width:120px;overflow:hidden;white-space:nowrap">Hello world</div></body>';

await test('a clean page has nothing to review at any depth', async () => {
  const report = await run([{ id: 'clean', html: CLEAN }]);
  assert.deepEqual(report.states[0].findings.filter(item => item.severity !== 'info'), []);
});

await test('nested summaries inside closed details are excluded from geometry checks', async () => {
  const html = '<body><details><summary>Outer settings</summary><details><summary></summary><button></button></details></details><button>Save</button></body>';
  const report = await run([{ id: 'closed-details', html }]);
  assert.deepEqual(kinds(report, 'closed-details@400'), []);
});

await test('controls inside a transparent hover dock are excluded from geometry checks', async () => {
  const html = '<body><div style="opacity:0;pointer-events:none"><button id="hidden-action" style="width:40px;height:30px"></button></div><div style="position:fixed;inset:0;background:#fff"></div></body>';
  const report = await run([{ id: 'transparent-dock', html }]);
  assert.deepEqual(kinds(report, 'transparent-dock@400'), []);
});

await test('overlap, a covered control, clipped text, sideways scrolling and an unnamed control are all measured', async () => {
  const report = await run([{ id: 'broken', html: BROKEN }]);
  for (const kind of ['overlap', 'covered-control', 'clipped-text', 'page-overflow', 'unnamed-control']) assert.ok(kinds(report, 'broken@400').includes(kind), `${kind} missing from ${kinds(report, 'broken@400')}`);
  const covered = report.states[0].findings.find(item => item.kind === 'covered-control');
  assert.equal(covered.severity, 'error'); assert.ok(covered.rect.w > 0 && covered.selector.includes('covered'));
  assert.ok(report.states[0].crop, 'the worst region is cropped for the model');
  assert.ok(fs.statSync(path.join(tmp, `out-${counter}`, 'crops', report.states[0].crop)).size > 100);
  assert.ok(report.needsVision.includes('broken@400'));
});

await test('text 45% longer exposes a layout that only breaks in other languages', async () => {
  const report = await run([{ id: 'long', html: LONG }]);
  const found = report.states[0].findings;
  assert.ok(found.some(item => item.kind === 'clipped-text' && item.stress === 'long-text'), JSON.stringify(found));
});

await test('baselines: the first run records, an identical run is quiet, a change is located, and --accept only stages', async () => {
  const first = await run([{ id: 'page', html: CLEAN }]);
  assert.equal(first.states[0].pixel.status, 'new'); assert.equal(first.summary.recorded, 1); assert.deepEqual(first.needsVision, []);
  const same = await run([{ id: 'page', html: CLEAN }]);
  assert.equal(same.states[0].pixel.status, 'same'); assert.equal(same.states[0].aria, 'same'); assert.deepEqual(same.needsVision, []);
  const changed = await run([{ id: 'page', html: CLEAN.replace('<button>Cancel</button>', '<button style="background:#c00;color:#fff;padding:24px">Cancel</button><h2>New heading</h2>') }], { accept: true });
  const state = changed.states[0];
  assert.equal(state.pixel.status, 'changed'); assert.ok(state.pixel.bbox && state.pixel.bbox.w > 0); assert.equal(state.aria, 'changed');
  assert.ok(state.ariaDiff.some(line => line.includes('New heading')), state.ariaDiff.join('|'));
  assert.ok(state.crop, 'the changed region is cropped'); assert.deepEqual(changed.needsVision, ['page@400']);
  const staged = path.join(tmp, `out-${counter}`, 'next-baseline');
  assert.ok(fs.existsSync(path.join(staged, 'page@400.png')), 'the next baseline is staged next to the report');
  const still = await run([{ id: 'page', html: CLEAN }]);
  assert.equal(still.states[0].pixel.status, 'same', 'the accepted baseline is untouched until the caller adopts it');
});

await test('a problem seen before is known the next night and is not sent to the model again', async () => {
  const baselineDir = path.join(tmp, 'known-baseline');
  const first = await run([{ id: 'broken', html: BROKEN }], { baselineDir });
  assert.ok(first.states[0].findings.some(item => item.isNew));
  const second = await run([{ id: 'broken', html: BROKEN }], { baselineDir });
  assert.ok(second.states[0].findings.length > 0 && second.states[0].findings.every(item => !item.isNew));
  assert.deepEqual(second.needsVision, []);
});

await test('the real chat page opens without script errors or missing files and its report names every scenario', async () => {
  const { scenarios } = await import('./ui-tester/scenarios.mjs');
  const report = await run(scenarios.filter(item => ['chat-empty', 'loops-tester'].includes(item.id)), { widths: [420] });
  assert.equal(report.states.length, 2);
  for (const state of report.states) assert.deepEqual(state.findings.filter(item => ['page-error', 'console-error', 'request-failed'].includes(item.kind)), [], state.id);
  assert.ok(fs.readFileSync(path.join(tmp, `out-${counter}`, 'report.md'), 'utf8').includes('| chat-empty |'));
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(results.join('\n'));
