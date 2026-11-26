'use strict';

// Unattended editors and readers for the loop. Each runs with its working folder set to the loop's private copy of the
// project, never the real checkout. Editing: Claude may only edit files (no shell, so no permission prompt can stall it),
// Codex runs in its workspace-write sandbox with approvals off, Gemini (Antigravity) in accept-edits mode inside its
// sandbox. Reading ("analyst"): no tools at all, or a read-only sandbox, so a reader cannot change anything.

const fs = require('node:fs');
const { locate } = require('./binary-locator');
const { cliTelemetry } = require('./cli-telemetry.js');
const { processOutput, usageTotal, extractJson, cliHelp } = require('./investigation-runner');
const { shimmed } = require('./loop-exec');

function withShim(agent, found, args, input) {
  const telemetry = cliTelemetry(agent);
  const spec = shimmed(found, [...telemetry.args, ...args]);
  return { ...spec, env: { ...spec.env, ...telemetry.env }, input };
}

// Claude takes the level as a flag and Codex as a config key; Antigravity has it in the model id.
const claudeModel = (model, effort) => [...(model && model !== 'claude' ? ['--model', model] : []), ...(effort ? ['--effort', effort] : [])];
const codexModel = (model, effort) => [...(model ? ['-m', model] : []), ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : [])];

function copilotTask(found, { cwd, model, prompt }, edit) {
  const { commandFor } = require('./providers/copilot.js');
  const { args, input } = commandFor({ fullPrompt: prompt, model, cwd });
  const tools = edit ? 'view,glob,grep,edit,create,apply_patch' : 'view,glob,grep,web_fetch,web_search';
  return withShim('copilot', found, [...args, '--no-ask-user', '--disable-builtin-mcps', `--available-tools=${tools}`,
    ...(edit ? ['--allow-tool=read,write'] : ['--allow-tool=read', '--deny-tool=write,shell', '--allow-all-urls'])], input);
}

function fixerSpec(agent, { model, effort, cwd, prompt }) {
  const found = locate(agent).path;
  if (!found) throw new Error(`The ${agent} CLI is not installed.`);
  if (agent === 'copilot') return copilotTask(found, { cwd, model, prompt }, true);
  let args, input = `${prompt}\n`;
  if (agent === 'claude') {
    args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--no-session-persistence', ...claudeModel(model, effort)];
  } else if (agent === 'codex') {
    args = ['exec', '--json', '--sandbox', 'workspace-write', '-c', 'approval_policy="never"', '--skip-git-repo-check', '-C', cwd, ...codexModel(model, effort), '-'];
  } else if (agent === 'gemini') {
    // Antigravity edits in accept-edits mode; its sandbox restricts the terminal. Chosen only when the user picks Gemini as editor.
    args = ['--model', model, '--mode', 'accept-edits', '--sandbox', '--disable-slash-commands', '--add-dir', cwd, '--input-format', 'stream-json', '--output-format', 'stream-json'];
    input = `${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`;
  } else throw new Error(`No unattended editor recipe for ${agent}.`);
  return withShim(agent, found, args, input);
}

/** A reader: same CLIs, no edit rights and no tools. The task goes in the prompt; the reply must be one JSON object. */
function readerSpec(agent, { model, cwd, prompt }) {
  const found = locate(agent).path;
  if (!found) throw new Error(`The ${agent} CLI is not installed.`);
  let args;
  if (agent === 'claude') {
    // --safe-mode keeps the user's hooks (completion chimes) and CLAUDE.md out of ten parallel readers, when this CLI has it.
    let safe = [];
    try { if (cliHelp(found).includes('--safe-mode')) safe = ['--safe-mode']; } catch { /* older CLI */ }
    args = ['-p', '--output-format', 'stream-json', '--verbose', '--tools', '', '--permission-mode', 'plan', '--no-session-persistence', ...safe, ...(model && model !== 'claude' ? ['--model', model] : [])];
  } else if (agent === 'codex') {
    args = ['exec', '--json', '--sandbox', 'read-only', '-c', 'approval_policy="never"', '--skip-git-repo-check', '--ephemeral', '-C', cwd, ...(model ? ['-m', model] : []), '-'];
  } else throw new Error(`No reader recipe for ${agent}.`);
  return withShim(agent, found, args, `${prompt}\n`);
}

/**
 * A researcher: reads files and the web, cannot edit or run commands. Claude is limited to read and web tools (anything else
 * is denied, not asked), Codex runs in its read-only sandbox with live web search, Antigravity in plan mode inside its sandbox.
 * The answer is plain text (the caller saves it), unlike a reader, which must return one JSON object.
 */
function researchSpec(agent, { model, effort, cwd, prompt }) {
  const found = locate(agent).path;
  if (!found) throw new Error(`The ${agent} CLI is not installed.`);
  if (agent === 'copilot') return copilotTask(found, { cwd, model, prompt }, false);
  let args, input = `${prompt}\n`;
  if (agent === 'claude') {
    let safe = []; // keeps the user's hooks (completion chimes), CLAUDE.md and MCP servers out of a delegated run, when this CLI has it
    try { if (cliHelp(found).includes('--safe-mode')) safe = ['--safe-mode']; } catch { /* older CLI */ }
    args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'dontAsk', '--allowedTools', 'WebSearch,WebFetch,Read,Glob,Grep', '--no-session-persistence', ...safe, ...claudeModel(model, effort)];
  } else if (agent === 'codex') {
    args = ['exec', '--json', '--sandbox', 'read-only', '-c', 'approval_policy="never"', '-c', 'web_search="live"', '--skip-git-repo-check', '--ephemeral', '-C', cwd, ...codexModel(model, effort), '-'];
  } else if (agent === 'gemini') {
    args = ['--model', model, '--mode', 'plan', '--sandbox', '--disable-slash-commands', '--add-dir', cwd, '--input-format', 'stream-json', '--output-format', 'stream-json'];
    // agy ends a noninteractive turn on a denied command, sometimes reporting SUCCESS with an empty response.
    const readOnly = 'This is a read-only research run. Terminal commands are unavailable: do not call run_command, command_status or send_command_input (including curl, PowerShell, Python or shell commands). Use the available file-reading tools for files, search_web for searches, and a read-only URL/browser tool for original pages if one is declared in your toolset. Do not assume a URL-reading tool is available. If a source cannot be opened with the available read tools, mark it [BLOCKED] and continue. Never attempt a denied action again or work around its denial. Always return your findings in a final text reply; do not write a result file yourself.';
    input = `${JSON.stringify({ event: 'user', message: { content: `${readOnly}\n\n${prompt}` } })}\n`;
  } else throw new Error(`No research recipe for ${agent}.`);
  return withShim(agent, found, args, input);
}

function parseLine(line, state, agent) {
  let raw; try { raw = JSON.parse(line); } catch { return; }
  if (!raw || typeof raw !== 'object') return;
  if (agent === 'copilot') {
    const { normalizeEvent, usage } = require('./providers/copilot.js');
    if (raw.agentId || raw.data?.parentToolCallId) return;
    if (raw.type === 'session.error') {
      state.providerError = normalizeEvent(raw)?.text;
      state.errored = true;
    } else if (raw.type === 'result' && raw.exitCode) {
      state.errored = true;
    } else if (raw.type === 'assistant.message') {
      const answer = normalizeEvent(raw)?.text;
      if (answer) {
        state.partial = state.partial ? `${state.partial}\n\n${answer}` : answer;
        if (!raw.data.toolRequests?.length) state.reply = answer;
        state.errored = false;
        state.providerError = null;
      }
    }
    const counts = usage(raw);
    if (counts) state.tokens = (state.tokens || 0) + counts.input + counts.output;
    return;
  }
  if (raw.type === 'result') { if (typeof raw.result === 'string') state.reply = raw.result; if (raw.is_error) state.errored = true; state.tokens = usageTotal(raw.usage) ?? state.tokens; } // claude
  else if (raw.type === 'assistant' && !raw.parent_tool_use_id) { // claude, mid-run: the text so far, kept in case the run dies before its result
    const text = (raw.message?.content || []).filter((part) => part?.type === 'text').map((part) => part.text).join('');
    if (text.trim()) state.partial = text;
  }
  else if (raw.type === 'item.completed' && raw.item?.type === 'agent_message' && typeof raw.item.text === 'string') { state.reply = raw.item.text; state.partial = raw.item.text; } // codex
  else if (raw.type === 'turn.completed') state.tokens = usageTotal(raw.usage) ?? state.tokens;
  else if (raw.event === 'result') { // antigravity
    state.providerResult = { status: raw.result?.status || 'unknown', conversationId: raw.result?.conversation_id || null, deniedActions: raw.result?.denied_actions || [] };
    if (raw.result?.status === 'ERROR') state.errored = true;
    state.reply = raw.result?.response || state.reply; state.tokens = usageTotal(raw.result?.usage || raw.usage) ?? state.tokens;
  }
}

/** Rejections carry `state` (what the CLI had said so far) and `stderr`, so a caller can still save the partial answer. */
async function runSpec(spec, agent, { cwd, signal, timeoutMs, idleMs, logFile, onActivity, onStatus, onSpawn, onProgress }) {
  const state = { reply: '', partial: '', tokens: null, errored: false };
  let result;
  try {
    result = await processOutput(spec.command, spec.args, { cwd, signal, timeoutMs, idleMs, onActivity, onSpawn, env: spec.env, input: spec.input, maxBytes: 8 * 1024 * 1024,
      onLine: line => {
        if (logFile) try { fs.appendFileSync(logFile, line.slice(0, 100000) + '\n'); } catch { /* the log is a diagnostic aid only */ }
        parseLine(line, state, agent);
        if (state.reply) onStatus?.('running');
        onProgress?.(state);
      } });
  } catch (error) { throw Object.assign(error, { state }); }
  if (result.code !== 0 || state.errored) {
    const detail = state.providerError || result.stderr?.trim().split(/\r?\n/).pop();
    throw Object.assign(new Error(`${agent} did not finish${detail ? `: ${detail.slice(0, 200)}` : '.'}`), { state, stderr: result.stderr });
  }
  if (agent === 'gemini' && !state.reply.trim()) {
    const info = state.providerResult;
    const denied = info?.deniedActions.map(action => action.display_name || action.action).join(', ');
    throw Object.assign(new Error(`gemini returned no final answer (provider status: ${info?.status || 'no result event'}${denied ? `; denied actions: ${denied}` : ''}). See log.jsonl${info?.conversationId ? `; conversation ${info.conversationId}` : ''}.`), { state, stderr: result.stderr });
  }
  return state;
}

/** Runs one fix to completion. Resolves `{reply, tokens}` (tokens null when the CLI reports none); rejects on failure, timeout or abort. */
async function runFixer({ agent, model, cwd, prompt, signal, timeoutMs, idleMs = 0, logFile, onActivity, onSpawn }) {
  const state = await runSpec(fixerSpec(agent, { model, cwd, prompt }), agent, { cwd, signal, timeoutMs, idleMs, logFile, onActivity, onSpawn });
  return { reply: state.reply, tokens: state.tokens };
}

/** Runs a read-only reader (Claude or Codex) and parses its last message as one JSON object. */
async function runReader({ agent, model, cwd, prompt, signal, timeoutMs, idleMs = 0, logFile, onActivity, onStatus, onSpawn }) {
  const state = await runSpec(readerSpec(agent, { model, cwd, prompt }), agent, { cwd, signal, timeoutMs, idleMs, logFile, onActivity, onStatus, onSpawn });
  if (!state.reply) throw new Error(`${agent} returned no report.`);
  return { report: extractJson(state.reply), tokens: state.tokens };
}

module.exports = { runFixer, runReader, runSpec, fixerSpec, readerSpec, researchSpec, parseLine };
