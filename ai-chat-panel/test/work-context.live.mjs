// Opt-in check of the real Clef Flash endpoint (CLANKER_LIVE=1; never part of `npm test`). Synthetic prompts only.
// Free only: its own 160-Neuron ledger caps the whole run (about 1.6% of Cloudflare's 10,000 free Neurons a day), and the
// router's guard stops before any call that would pass it. Credentials come from CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN.
//   CLANKER_LIVE=1 node ai-chat-panel/test/work-context.live.mjs [--probe]   (--probe: one call, prints the raw answer)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Router } = require('../lib/routing');
const wc = require('../lib/work-context');
if (process.env.CLANKER_LIVE !== '1') { console.log('Set CLANKER_LIVE=1 to call Cloudflare (free allowance, capped at 160 Neurons).'); process.exitCode = 0; throw new Error('CLANKER_LIVE is not set'); }

const CAP = 160;
const env = { routingCloudflareAccount: process.env.CLOUDFLARE_ACCOUNT_ID, routingCloudflareToken: process.env.CLOUDFLARE_API_TOKEN };
let stored = {};
const router = new Router({ getConfig: () => ({}), secrets: { get: async (key) => env[key] || '' }, store: { get: () => stored, set: (value) => { stored = value; } } });
const ledger = new wc.NeuronLedger(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wc-live-')), 'ledger.json'));
const guard = { cap: CAP, lease: (reserve) => ledger.lease(reserve, CAP) };
const msg = (role, text) => ({ role, text });
const ask = async (messages, current = null) => {
  const payload = wc.buildPayload({ messages, workContext: current && { version: 1, categoryId: current } });
  const started = Date.now();
  const raw = await router.callTier('cloudflare', payload, false, guard);
  return { raw, ms: Date.now() - started, choice: wc.readChoice(raw) };
};

if (process.argv.includes('--probe')) {
  const { raw, ms } = await ask([msg('user', 'The login page throws a 500 when the OAuth token expires. Fix the refresh so users stay signed in.')]);
  console.log(JSON.stringify(raw, null, 1), `\n${ms} ms; ledger ${ledger.spent().toFixed(2)} Neurons`);
  } else {

// [expected category, conversation, current category]
const cases = [
  ['backend', [msg('user', 'Add a REST endpoint that returns the weekly usage totals and make the background poller retry when the upstream service times out.')]],
  ['database', [msg('user', 'Write a migration that adds an index on chats.updated_at and backfills the new project_id column without locking the table.')]],
  ['auth', [msg('user', 'Users get signed out after an hour. Fix the OAuth refresh-token flow so the session survives token expiry.')]],
  ['frontend', [msg('user', 'Wire up the settings modal: the save button should validate the form, show errors inline and close the dialog on success.')]],
  ['design', [msg('user', 'The sidebar looks cramped. Increase the spacing, soften the corner radius and pick a calmer accent color and typography.')]],
  ['motion', [msg('user', 'Make the card expand with a spring animation and tune the easing curve so the hover transition feels less abrupt.')]],
  ['testing', [msg('user', 'Write unit tests for the retry logic and add a regression test that covers the empty-queue case. Then run the whole suite.')]],
  ['debugging', [msg('user', 'The app freezes for about three seconds after startup but only on some machines. I have no idea why. Help me find what is going on.')]],
  ['research', [msg('user', 'Look up which Cloudflare Workers AI models support image input and what their free limits are. Summarize with links.')]],
  ['planning', [msg('user', 'Before we build anything, let us discuss the architecture for syncing chats between two machines and compare the tradeoffs.')]],
  ['documentation', [msg('user', 'Rewrite the README so a new contributor can install it and run the checks in five minutes. Keep it short and friendly.')]],
  ['devops', [msg('user', 'The GitHub Actions workflow fails to cache node_modules and the packaging step cannot find the installer. Fix the build pipeline.')]],
  ['performance', [msg('user', 'Scrolling the chat list drops frames. Profile it, find the hot spots and cut the render time and memory usage.')]],
  ['security', [msg('user', 'Audit this project for leaked secrets and unsafe input handling, and propose hardening measures for the file upload route.')]],
  ['voice', [msg('user', 'The dictation hotkey records but the transcription comes back empty. Check the microphone capture and the speech-to-text request.')]],
  ['study', [msg('user', 'Help me revise thermodynamics for my exam: explain entropy and quiz me on the main concepts.')]],
  ['notes', [msg('user', 'Turn these meeting notes into minutes with decisions and action items: Anna approved the draft; Ben will send the figures by Friday.')]],
  ['organizing', [msg('user', 'Organize my lecture files and notes into a folder structure with consistent names and tags for my knowledge base.')]],
  ['schedule', [msg('user', 'Make a weekly calendar and to-do list with time blocks for my deadlines, appointments and daily routines.')]],
  ['math', [msg('user', 'Calculate the mean, sample variance and standard deviation of 3, 5, 8, 12 and explain each formula.')]],
  ['language', [msg('user', 'Translate this sentence into German and correct its grammar: I has been waiting since two hours.')]],
  ['ideas', [msg('user', 'Brainstorm ten creative names for a neighbourhood book club and help me choose the most memorable one.')]],
  ['life', [msg('user', 'Help me make a packing list for a weekend holiday with a toddler, including travel documents and toiletries.')]],
  ['general', [msg('user', 'Hello! Thanks for your help earlier. Nice to chat again.')]],
  // Context-dependent: the request alone does not say what the work is.
  ['design', [msg('user', 'I want the recent chat tiles to feel more polished: nicer corner icons, better spacing and color.'), msg('assistant', 'I can restyle the tiles and add small icons. Shall I go ahead?'), msg('user', 'Yes, go ahead and build it.')]],
  ['auth', [msg('user', 'Fix the OAuth refresh so sessions stay signed in.'), msg('assistant', 'Done, the refresh token is now rotated.'), msg('user', 'continue')], 'auth'],
  ['voice', [msg('user', 'Restyle the settings page with a calmer palette.'), msg('assistant', 'Done.'), msg('user', 'Now switch to the microphone selection: the dictation should use the headset I pick, not the default device.')], 'design'],
];

const rows = [];
for (const [expected, messages, current = null] of cases) {
  try {
    const { choice, ms } = await ask(messages, current);
    const applied = wc.decide(current, choice);
    const finalId = applied || current;
    rows.push({ expected, top: choice?.id, p: choice?.probability, runnerUp: choice?.runnerUp, ms, finalId, ok: choice?.id === expected || finalId === expected });
  } catch (error) { rows.push({ expected, error: error.message }); if (/budget/.test(error.message)) break; }
}
for (const row of rows) console.log(row.error ? `ERR  ${row.expected}: ${row.error}` : `${row.ok ? 'ok  ' : 'MISS'} want ${row.expected.padEnd(13)} got ${String(row.top).padEnd(13)} p=${row.p?.toFixed(2)} runner=${row.runnerUp?.toFixed(2)} -> ${row.finalId ?? 'unchanged/none'} (${row.ms} ms)`);
const done = rows.filter((row) => !row.error);
const top1 = done.filter((row) => row.top === row.expected).length;
const confident = done.filter((row) => row.finalId && row.finalId !== null && row.p >= 0.7);
const wrongConfident = confident.filter((row) => row.finalId !== row.expected).length;
console.log(`\ntop-1 ${top1}/${done.length}; applied after thresholds: ${confident.length}, wrong among them: ${wrongConfident}; median ${[...done.map((row) => row.ms)].sort((a, b) => a - b)[Math.floor(done.length / 2)]} ms`);
console.log(`spent (reserved/measured) ${ledger.spent().toFixed(2)} of ${CAP} Neurons; router counter ${router.usage().neurons.toFixed(2)}`);
if (done.length !== cases.length || top1 !== cases.length || wrongConfident) process.exitCode = 1;
}
