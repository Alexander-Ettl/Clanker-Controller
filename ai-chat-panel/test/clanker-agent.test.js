'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// The vendor CLIs are never started: their locations are faked before the recipes load, and the worker runs a stand-in script.
const locator = require('../lib/binary-locator');
locator.locate = (agent) => ({ agent, path: `C:\\fake\\${agent}.exe`, checked: [] });
const { researchSpec, fixerSpec, parseLine } = require('../lib/investigation-fixer');
const agent = require('../lib/clanker-agent');

const SPEC = path.join(__dirname, 'clanker-agent-spec.js');
const made = [];
const tmp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-agent-')); made.push(dir); return dir; };
// Jobs started here are indexed under <CLANKER_HOME>/jobs/<chat>. Without this, a test run inside a Clanker chat (which exports
// CLANKER_CHAT_ID) listed every fake job in that chat's real agents chip: 47 runs left 376 "agents" in one chat.
const TEST_HOME = tmp();
const TEST_CHAT = 'clanker-agent-test-chat';
process.env.CLANKER_HOME = TEST_HOME;
process.env.CLANKER_CHAT_ID = TEST_CHAT;
test.after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });
const entry = (agentId, id, label, extra = {}) => ({ id, agent: agentId, model: id, effort: null, label, company: { claude: 'Anthropic', codex: 'OpenAI', gemini: 'Google' }[agentId], ...extra });
const CATALOG = [
  entry('gemini', 'gemini-4-argon-low', 'Gemini 4 Argon Low'), entry('gemini', 'gemini-4-argon-medium', 'Gemini 4 Argon Medium'), entry('gemini', 'gemini-4-argon-high', 'Gemini 4 Argon High'),
  entry('gemini', 'gemini:claude-sonnet-5-5-medium', 'Claude Sonnet 5.5 Medium', { model: 'claude-sonnet-5-5-medium' }),
  entry('codex', 'gpt-6.1-sol-medium', 'GPT-6.1-Sol Medium', { model: 'gpt-6.1-sol', effort: 'medium' }), entry('codex', 'gpt-6.1-sol-high', 'GPT-6.1-Sol High', { model: 'gpt-6.1-sol', effort: 'high' }),
  entry('codex', 'gpt-6-sol-medium', 'GPT-6-Sol Medium', { model: 'gpt-6-sol', effort: 'medium' }), entry('codex', 'gpt-6-sol-high', 'GPT-6-Sol High', { model: 'gpt-6-sol', effort: 'high' }),
  entry('claude', 'claude-sonnet-5-5-medium', 'Claude Sonnet 5.5 Medium', { model: 'claude-sonnet-5-5', effort: 'medium' }),
];
const run = async (argv, extra = {}) => { const lines = []; const code = await agent.main(argv, { out: (t) => lines.push(t), err: (t) => lines.push(t), catalog: CATALOG, ...extra }); return { code, text: lines.join('\n') }; };

test('the names a person types find the model, including the two from the failed run', () => {
  assert.deepEqual(agent.resolveTarget('Gemini 4 Argon Medium', CATALOG), { agent: 'gemini', model: 'gemini-4-argon-medium', effort: null, label: 'Gemini 4 Argon Medium' });
  assert.deepEqual(agent.resolveTarget('Codex Sol 6.1 Medium', CATALOG), { agent: 'codex', model: 'gpt-6.1-sol', effort: 'medium', label: 'GPT-6.1-Sol Medium' });
  assert.equal(agent.resolveTarget('gpt-6.1-sol-high', CATALOG).effort, 'high');
  assert.equal(agent.resolveTarget('codex:gpt-6.1-sol', CATALOG).effort, 'medium', 'only the effort is open: medium');
  assert.equal(agent.resolveTarget('Gemini 4 Argon', CATALOG).model, 'gemini-4-argon-medium');
  assert.equal(agent.resolveTarget('Claude Sonnet 5.5', CATALOG).agent, 'claude', 'the native CLI wins over the same model reached through Antigravity');
  assert.equal(agent.resolveTarget('gemini:claude-sonnet-5-5-medium', CATALOG).agent, 'gemini');
  assert.deepEqual(agent.resolveTarget('claude:opus', CATALOG), { agent: 'claude', model: 'opus', effort: null, label: 'opus' }, 'an unlisted model passes through');
  assert.throws(() => agent.resolveTarget('sol', CATALOG), /fits 2 models.*codex:gpt-6\.1-sol-medium/, 'an ambiguous name lists the candidates');
  assert.throws(() => agent.resolveTarget('mistral large', CATALOG), /No model matches/);
});

test('each vendor gets a read-only research recipe with its effort', () => {
  const args = (vendor, extra) => researchSpec(vendor, { cwd: 'C:\\p', prompt: 'x', ...extra }).args;
  const claude = args('claude', { model: 'claude-opus-5-5', effort: 'high' });
  assert.deepEqual(claude.slice(claude.indexOf('--permission-mode'), claude.indexOf('--permission-mode') + 4), ['--permission-mode', 'dontAsk', '--allowedTools', 'WebSearch,WebFetch,Read,Glob,Grep']);
  assert.ok(claude.join(' ').includes('--model claude-opus-5-5 --effort high'));
  const codex = args('codex', { model: 'gpt-6.1-sol', effort: 'medium' }).join(' ');
  assert.ok(codex.includes('--sandbox read-only') && codex.includes('web_search="live"') && codex.includes('-m gpt-6.1-sol -c model_reasoning_effort="medium"'));
  const gemini = researchSpec('gemini', { model: 'gemini-4-argon-medium', cwd: 'C:\\p', prompt: 'hi' });
  assert.ok(gemini.args.join(' ').includes('--model gemini-4-argon-medium --mode plan --sandbox'));
  assert.match(JSON.parse(gemini.input).message.content, /Terminal commands are unavailable[\s\S]*Do not assume a URL-reading tool is available[\s\S]*hi$/);
  assert.ok(!fixerSpec('codex', { model: 'm', effort: 'low', cwd: 'C:\\p', prompt: 'x' }).args.includes('read-only'), 'edit recipe still edits');
});

test('mid-run text is kept from Claude and Codex, not from a sub-agent', () => {
  const state = { reply: '', partial: '' };
  parseLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'main' }] } }), state);
  parseLine(JSON.stringify({ type: 'assistant', parent_tool_use_id: 't1', message: { content: [{ type: 'text', text: 'child' }] } }), state);
  assert.equal(state.partial, 'main');
  parseLine(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'codex says' } }), state);
  assert.equal(state.partial, 'codex says');
});

test('a Copilot delegation keeps the default model, project root, permissions and final JSONL reply', async () => {
  const cwd = tmp();
  const home = tmp();
  const copilot = entry('copilot', 'copilot-auto', 'Copilot · Auto', { model: 'auto', isDefault: true });
  agent.publish({ home, models: [entry('copilot', 'copilot-fast', 'Copilot · Fast', { model: 'fast' }), copilot] });
  const catalog = agent.readCatalog(home);
  assert.equal(agent.resolveTarget('copilot', catalog).model, 'auto');
  assert.equal(agent.resolveTarget('copilot:new-model', catalog).model, 'new-model');
  const launch = { cwd, model: 'auto', prompt: 'Read the status file' };
  const read = researchSpec('copilot', launch);
  const edit = fixerSpec('copilot', launch);
  assert.ok(read.args.includes('--available-tools=view,glob,grep,web_fetch,web_search'));
  assert.ok(read.args.includes('--deny-tool=write,shell') && !read.args.includes('--allow-all-tools'));
  assert.ok(edit.args.includes('--allow-tool=read,write') && !edit.args.includes('--allow-all-tools'));
  assert.deepEqual(read.args.slice(read.args.indexOf('--add-dir'), read.args.indexOf('--add-dir') + 2), ['--add-dir', cwd]);
  const records = require('./fixtures/copilot-events.json');
  const spec = () => ({ command: process.execPath, args: ['-e', `process.stdout.write(${JSON.stringify(records.map(record => JSON.stringify(record)).join('\n'))})`], env: {}, input: '' });
  const result = await run(['run', '--to', 'copilot', '--task', 'status', '--prompt', 'Read the status file', '--cwd', cwd], { inline: true, catalog, spec });
  assert.equal(result.code, 0, result.text);
  const dir = agent.jobDir('status', cwd);
  assert.equal(agent.readStatus(dir).tokens, 175);
  assert.equal(fs.readFileSync(path.join(dir, 'result.md'), 'utf8'), 'The patch and checks passed.\n\n- Status updated\n- Checks passed\n');
});

test('Copilot API errors keep their diagnostic and partial reply in the failed job', async () => {
  const cwd = tmp();
  const records = [
    { type: 'assistant.message', data: { content: 'I found the file.', toolRequests: [{ toolCallId: 'view-1' }] } },
    { type: 'session.error', data: { message: '401 authentication expired' } },
    { type: 'result', exitCode: 1 },
  ];
  const spec = () => ({ command: process.execPath, args: ['-e', `process.stdout.write(${JSON.stringify(records.map(record => JSON.stringify(record)).join('\n'))})`], env: {}, input: '' });
  const result = await run(['run', '--to', 'copilot:auto', '--task', 'expired', '--prompt', 'Read the file', '--cwd', cwd], { inline: true, spec });
  assert.equal(result.code, 1);
  const dir = agent.jobDir('expired', cwd);
  assert.match(agent.readStatus(dir).hint, /Sign in to copilot/);
  assert.match(fs.readFileSync(path.join(dir, 'result.md'), 'utf8'), /^> INCOMPLETE:.*401 authentication expired\n\nI found the file\./);
});

test('Gemini empty SUCCESS after a denied command fails with provider diagnostics, not a fabricated answer', async () => {
  const cwd = tmp();
  const raw = { event: 'result', result: { status: 'SUCCESS', response: '', conversation_id: 'denied-conversation', denied_actions: [{ action: 'command', display_name: 'RunCommand' }] } };
  const spec = () => ({ command: process.execPath, args: ['-e', `console.log(${JSON.stringify(JSON.stringify(raw))})`], env: {}, input: '' });
  const result = await run(['run', '--to', 'Gemini 4 Argon Medium', '--task', 'denied', '--prompt', 'p', '--cwd', cwd], { inline: true, spec });
  assert.equal(result.code, 1);
  const dir = path.join(cwd, '_work', 'clanker', 'denied');
  const status = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
  assert.equal(status.partialChars, 0);
  assert.match(status.error, /no final answer.*SUCCESS.*denied actions: RunCommand.*denied-conversation/);
  assert.deepEqual(status.providerResult.deniedActions, raw.result.denied_actions);
  assert.match(fs.readFileSync(path.join(dir, 'result.md'), 'utf8'), /^> INCOMPLETE:.*denied actions: RunCommand/);
});

test('Gemini completed responses are saved, while an empty response without denial still fails', async () => {
  for (const response of ['A completed Gemini answer.', '']) {
    const cwd = tmp();
    const raw = { event: 'result', result: { status: 'SUCCESS', response } };
    const spec = () => ({ command: process.execPath, args: ['-e', `console.log(${JSON.stringify(JSON.stringify(raw))})`], env: {}, input: '' });
    const result = await run(['run', '--to', 'Gemini 4 Argon Medium', '--task', 'response', '--prompt', 'p', '--cwd', cwd], { inline: true, spec });
    assert.equal(result.code, response ? 0 : 1);
    const saved = fs.readFileSync(path.join(cwd, '_work', 'clanker', 'response', 'result.md'), 'utf8');
    assert.match(saved, response ? /A completed Gemini answer/ : /no final answer \(provider status: SUCCESS\)/);
  }
});

test('a finished task leaves result.md, a done status and tagged sources', async () => {
  const cwd = tmp();
  const r = await run(['run', '--to', 'Codex Sol 6.1 Medium', '--task', 'Amazon Reviews', '--prompt', 'MODE:ok find reviews', '--cwd', cwd], { inline: true, spec: require(SPEC) });
  assert.equal(r.code, 0, r.text);
  const dir = path.join(cwd, '_work', 'clanker', 'amazon-reviews');
  const status = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
  assert.deepEqual([status.state, status.agent, status.model, status.effort, status.resultFile, status.warnings], ['done', 'codex', 'gpt-6.1-sol', 'medium', 'result.md', []]);
  assert.match(fs.readFileSync(path.join(dir, 'result.md'), 'utf8'), /\[READ\] https:\/\/example\.com\/a/);
  assert.match(fs.readFileSync(path.join(dir, 'prompt.md'), 'utf8'), /Never tag a page \[READ\] that you did not open[\s\S]*find reviews/);
  assert.ok(!fs.existsSync(path.join(dir, 'result.partial.md')));
  assert.match(r.text, /DONE\s+amazon-reviews\s+codex:gpt-6\.1-sol \(medium\)/);
  assert.equal((await run(['result', 'amazon-reviews', '--cwd', cwd])).text.split('\n')[0], 'Finding one.');
});

test('a failed task still saves what was said, says why, and says what to do', async () => {
  const cwd = tmp();
  const r = await run(['run', '--to', 'Gemini 4 Argon Medium', '--task', 'reddit', '--prompt', 'MODE:fail x', '--cwd', cwd], { inline: true, spec: require(SPEC) });
  assert.equal(r.code, 1);
  const dir = path.join(cwd, '_work', 'clanker', 'reddit');
  const status = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
  assert.equal(status.state, 'failed');
  assert.match(status.hint, /Sign in to gemini/);
  const saved = fs.readFileSync(path.join(dir, 'result.md'), 'utf8');
  assert.match(saved, /^> INCOMPLETE: .*401/);
  assert.match(saved, /Half an answer so far\./);
  assert.match(r.text, /FAILED[\s\S]*hint\s+Not signed in/);
});

test('an answer with URLs but no source tags is flagged', async () => {
  const cwd = tmp();
  const untagged = (request, args) => ({ command: process.execPath, args: ['-e', "console.log(JSON.stringify({type:'result',result:'see https://x.example/p'}))"], env: {}, input: '' });
  await run(['run', '--to', 'codex:gpt-6.1-sol', '--task', 't', '--prompt', 'p', '--cwd', cwd], { inline: true, spec: untagged });
  assert.match(JSON.parse(fs.readFileSync(path.join(cwd, '_work', 'clanker', 't', 'status.json'), 'utf8')).warnings[0], /no \[READ\]/);
});

test('start returns at once, the detached worker finishes, and wait reports the file', async () => {
  const cwd = tmp();
  process.env.CLANKER_AGENT_SPEC_MODULE = SPEC;
  try {
    const started = await run(['start', '--to', 'Codex Sol 6.1 Medium', '--task', 'bg', '--prompt', 'MODE:ok', '--cwd', cwd]);
    assert.equal(started.code, 0, started.text);
    assert.match(started.text, /started\s+bg/);
    const waited = await run(['wait', 'bg', '--cwd', cwd, '--timeout', '30']);
    assert.equal(waited.code, 0, waited.text);
    assert.match(waited.text, /DONE[\s\S]*result\s+.*result\.md/);
    assert.equal((await run(['list', '--cwd', cwd])).text.split('\n')[0].slice(0, 4), 'DONE');
  } finally { delete process.env.CLANKER_AGENT_SPEC_MODULE; }
});

test('cancel stops a running task, keeps its partial answer and a dead worker is not reported as running', async () => {
  const cwd = tmp();
  process.env.CLANKER_AGENT_SPEC_MODULE = SPEC;
  try {
    await run(['start', '--to', 'codex:gpt-6.1-sol', '--task', 'hang', '--prompt', 'MODE:hang', '--cwd', cwd]);
    const dir = path.join(cwd, '_work', 'clanker', 'hang');
    const progress = /^RUNNING[\s\S]*progress\s+\d+ chars so far/;
    let running = await run(['status', 'hang', '--cwd', cwd]);
    for (let i = 0; i < 40 && !progress.test(running.text); i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      running = await run(['status', 'hang', '--cwd', cwd]);
    }
    assert.match(running.text, progress);
    const timedOut = await run(['wait', 'hang', '--cwd', cwd, '--timeout', '1']);
    assert.equal(timedOut.code, 2, 'still running is its own exit code');
    const cancelled = await run(['cancel', 'hang', '--cwd', cwd]);
    assert.match(cancelled.text, /^CANCELLED/);
    assert.match(fs.readFileSync(path.join(dir, 'result.md'), 'utf8'), /INCOMPLETE: cancelled[\s\S]*Half an answer/);

    // A worker that vanished without a word (restart, sandbox) must turn into "failed" with the partial kept.
    const orphan = path.join(cwd, '_work', 'clanker', 'orphan');
    fs.mkdirSync(orphan, { recursive: true });
    fs.writeFileSync(path.join(orphan, 'result.partial.md'), 'a few lines');
    const dead = spawnSync(process.execPath, ['-e', '0']).pid;
    fs.writeFileSync(path.join(orphan, 'status.json'), JSON.stringify({ id: 'orphan', state: 'running', pid: dead, agent: 'codex', model: 'm', createdAt: new Date().toISOString() }));
    const checked = await run(['status', 'orphan', '--cwd', cwd]);
    assert.match(checked.text, /^FAILED[\s\S]*worker process ended/);
    assert.match(fs.readFileSync(path.join(orphan, 'result.md'), 'utf8'), /INCOMPLETE[\s\S]*a few lines/);
  } finally { delete process.env.CLANKER_AGENT_SPEC_MODULE; }
});

test('the extension publishes a launcher at a fixed place and the model list the picker shows', async () => {
  const home = tmp();
  const launcher = agent.publish({ models: CATALOG, home });
  assert.equal(launcher, path.join(home, 'clanker-agent.js'));
  const again = fs.statSync(launcher).mtimeMs;
  agent.publish({ models: CATALOG, home });
  assert.equal(fs.statSync(launcher).mtimeMs, again, 'an unchanged file is not rewritten');
  const listed = spawnSync(process.execPath, [launcher, 'models', 'argon', 'medium'], { encoding: 'utf8', env: { ...process.env, CLANKER_HOME: home } });
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /gemini\s+Gemini 4 Argon Medium/);
  assert.doesNotMatch(listed.stdout, /Low|has not published/);
});

test('a CLI the sidebar shows as signed out is refused at once, with the hint, and no worker starts', async () => {
  const home = tmp(), cwd = tmp();
  agent.publish({ models: CATALOG, home, faults: { codex: { title: 'Signed out', detail: 'Codex needs you to sign in again.' }, claude: null } });
  const refused = await agent.start({ to: 'Codex Sol 6.1 Medium', task: 'x', prompt: 'hi', cwd }, { catalog: CATALOG, home });
  const status = agent.readStatus(refused.dir);
  assert.equal(status.state, 'failed');
  assert.match(status.error, /Signed out: Codex needs you to sign in/);
  assert.match(status.hint, /Sign in to codex/);
  assert.equal(status.pid, undefined, 'no worker ran');
  assert.match(fs.readFileSync(path.join(refused.dir, 'result.md'), 'utf8'), /INCOMPLETE[\s\S]*not started/);
  assert.equal(agent.publishedFault('claude', home), null, 'a vendor without a fault is untouched');
  // A published fault that is old is not trusted: the editor may be closed and the CLI signed in again since.
  const file = path.join(home, 'agent-bridge.json');
  const stale = JSON.parse(fs.readFileSync(file, 'utf8')); stale.publishedAt = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  fs.writeFileSync(file, JSON.stringify(stale));
  assert.equal(agent.publishedFault('codex', home), null);
});

test('mistakes are explained, not thrown', async () => {
  assert.match((await run(['start', '--to', 'Codex Sol 6.1 Medium', '--cwd', tmp()], { inline: true })).text, /No prompt/);
  assert.match((await run(['status', 'nope', '--cwd', tmp()])).text, /No task "nope"/);
  assert.match((await run([])).text, /hand a task to a model/);
});

test('jobs started by a test are indexed in the test home, never in the real ~/.clanker', async () => {
  const cwd = tmp();
  await agent.start({ to: 'codex:gpt-6.1-sol', task: 'isolated', prompt: 'x', cwd }, { catalog: CATALOG, inline: true });
  assert.ok(agent.indexedJobs(TEST_CHAT, TEST_HOME).includes(path.join(cwd, '_work', 'clanker', 'isolated')));
  assert.notEqual(process.env.CLANKER_HOME, path.join(os.homedir(), '.clanker'));
});
