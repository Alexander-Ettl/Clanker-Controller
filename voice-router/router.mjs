#!/usr/bin/env node
'use strict';

import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

import { readQuotas } from './lib/quota-reader.mjs';
import { runPipeline, transcribeAudio } from './lib/groq-client.mjs';
import { synthesizeBatch } from './lib/batch-synthesizer.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Minimal .env loader (no dependency): tools/voice-router/.env is gitignored
// via the repo's bare `.env` pattern, so GROQ_API_KEY lives there, not in
// shell history or chat.
function loadEnvFile(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return;
  }
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile(path.join(HERE, '.env'));

function parseArgs(argv) {
  const args = { text: null, audio: null, file: null, batch: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--text') args.text = argv[++index];
    else if (arg === '--audio') args.audio = argv[++index];
    else if (arg === '--file') args.file = argv[++index];
    else if (arg === '--batch') {
      const next = argv[index + 1];
      if (next && !next.startsWith('--')) {
        args.batch = argv[++index];
      } else {
        args.batch = true;
      }
    }
    else if (arg === '--json') args.json = true;
  }
  return args;
}

function getGitBranch() {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: HERE,
      encoding: 'utf8',
    }).trim();
  } catch {
    return undefined;
  }
}

function copyToClipboard(text) {
  return new Promise((resolve, reject) => {
    let command = 'xclip';
    let commandArgs = ['-selection', 'clipboard'];
    if (process.platform === 'win32') {
      command = 'clip';
      commandArgs = [];
    } else if (process.platform === 'darwin') {
      command = 'pbcopy';
      commandArgs = [];
    }

    const child = spawn(command, commandArgs, { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`))));
    child.stdin.end(text);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.batch) {
    let batchFile = typeof args.batch === 'string' ? path.resolve(process.cwd(), args.batch) : null;
    if (!batchFile) {
      const candidates = [
        path.resolve(HERE, '../../../site/.astro/session/batch-tasks.json'),
        path.resolve(process.cwd(), 'site/.astro/session/batch-tasks.json'),
        path.resolve(process.cwd(), '.astro/session/batch-tasks.json'),
      ];
      batchFile = candidates.find((p) => fs.existsSync(p));
    }

    if (!batchFile || !fs.existsSync(batchFile)) {
      console.error(`Error: Could not locate batch file: ${batchFile || '.astro/session/batch-tasks.json'}`);
      process.exitCode = 1;
      return;
    }

    let tasks = [];
    try {
      tasks = JSON.parse(fs.readFileSync(batchFile, 'utf8'));
    } catch (e) {
      console.error(`Error parsing ${batchFile}: ${e.message}`);
      process.exitCode = 1;
      return;
    }

    const quotas = readQuotas();
    const result = synthesizeBatch(tasks, { quotas });

    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(`\n=== Multi-Agent Batch Synthesis ===`);
    console.log(`Total Staged Tasks: ${result.totalTasks}`);
    console.log(`Breakdown: ${result.breakdown.uiTasks} UI -> Claude | ${result.breakdown.backendTasks} Backend -> Codex | ${result.breakdown.planningTasks} Planning -> Gemini`);
    console.log(`Quota Status: Claude 5h @ ${result.quotasUsed.claude5hRemainingPct}% (Failover: ${result.quotasUsed.isClaudeThrottled})`);
    console.log(`-----------------------------------\n`);

    // P12-B: each key now holds an array of sequenced phases (usually just
    // one) rather than a single package -- flatten in key order so a
    // bucket the affinity slicer split still prints/copies every phase.
    const allPhases = [];
    for (const [key, phases] of Object.entries(result.packages)) {
      for (const pkg of phases) {
        allPhases.push(pkg);
        const phaseNote = pkg.totalPhases > 1 ? ` -- Phase ${pkg.phase}/${pkg.totalPhases}` : '';
        console.log(`=== Package for [${pkg.targetModel.toUpperCase()}] (${pkg.taskCount} tasks bundled)${phaseNote} ===`);
        console.log(pkg.formattedPrompt);
        console.log('\n-----------------------------------\n');
      }
    }

    const primary = allPhases[0];
    if (primary) {
      try {
        await copyToClipboard(primary.formattedPrompt);
        console.log(`[OK] Primary package ([${primary.targetModel.toUpperCase()}]) copied to clipboard.`);
      } catch (err) {
        console.log(`[!] Clipboard copy failed: ${err.message}`);
      }
    }
    return;
  }

  if (!args.text && !args.audio) {
    console.error('Usage: node router.mjs --text "<prompt>" | --audio <file> | --batch [file] [--file <activeFile>] [--json]');
    process.exitCode = 1;
    return;
  }

  const startedAt = performance.now();

  const rawTranscript = args.audio ? await transcribeAudio(args.audio) : args.text;
  const quotas = readQuotas();
  const gitBranch = getGitBranch();

  const output = await runPipeline(rawTranscript, {
    context: { activeFile: args.file ?? undefined, gitBranch },
    quotas,
  });

  let clipboardError = null;
  try {
    await copyToClipboard(output.cleanedPrompt);
  } catch (error) {
    clipboardError = error;
  }

  const elapsedMs = Math.round(performance.now() - startedAt);

  if (args.json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  console.log(`-> ${output.decision.targetModel.toUpperCase()}  (${Math.round(output.decision.confidence * 100)}% confidence, ${elapsedMs}ms)`);
  console.log(`   intent:    ${output.decision.primaryIntent}`);
  console.log(`   reason:    ${output.decision.routingReason}`);
  console.log(`   dispatch:  ${output.suggestedDispatch}`);
  console.log(`   clipboard: ${clipboardError ? `failed (${clipboardError.message})` : 'cleaned prompt copied'}`);
  console.log('');
  console.log(output.cleanedPrompt);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
