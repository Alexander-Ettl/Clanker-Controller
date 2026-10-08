#!/usr/bin/env node
'use strict';

// Real source snapshot/checks/render, fake model response. Never spends AI usage.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { investigate, processOutput } = require('../ai-chat-panel/lib/investigation-runner');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-investigation-smoke-'));
  const checks = [];
  const result = await investigate({ job: { root: path.resolve(__dirname, '..'), model: 'gemini-3.8-flash-high',
    limits: { maxTokensPerRun: 40000, maxRunMinutes: 8 } }, run: { topic: 'cancellation and interrupted runs' },
    directory, signal: new AbortController().signal }, {
    execute: async (command, args, options) => {
      const result = await processOutput(command, args, options);
      checks.push({ name: args.join(' '), code: result.code }); return result;
    },
    flash: async () => ({ tokens: 0, report: { summary: 'Smoke check only; Flash response mocked.', findings: [], questions: [] } })
  });
  console.log(JSON.stringify({ checks, snapshotHash: result.snapshotHash, artifacts: result.artifacts }, null, 2));
  if (checks.some(check => check.code !== 0)) process.exitCode = 1;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
