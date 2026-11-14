'use strict';

// A complete, plain-text copy of one chat that any agent can open with its
// ordinary file Read tool. Cross-agent briefings (chat-handoff.js) shorten
// things to fit a budget; every shortened part points back to a line in this
// file, so nothing a briefing leaves out is lost to the receiving agent.
//
// The file is derived data: it is rebuilt from the chat's messages (the chat
// snapshot and tool-output blobs stay the source of truth) and never edited.

/** recordToolEnd keeps at most this many characters of a tool's output. */
const RECORDED_OUTPUT_CHARS = 16000;

/** Messages grouped into turns: one user message plus what followed it. */
function turnsOf(messages) {
  const turns = [];
  for (const message of messages) {
    if (message.role === 'user') turns.push({ user: message, answers: [], tools: [], steps: [], items: [] });
    else if (turns.length && (message.role === 'assistant' || message.role === 'tool')) {
      const turn = turns[turns.length - 1];
      turn.items.push(message);
      if (message.role === 'assistant') turn.answers.push(message);
      else { turn.tools.push(message.event); turn.steps.push(message); }
    }
  }
  return turns;
}

const oneLine = (text, max) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** How a recorded tool call ended: ok, failed (with exit code and first error line), interrupted, or never reported. */
function toolStatus(step = {}) {
  const event = step.event || {};
  const exitCode = Number.isInteger(event.exitCode) ? event.exitCode : null;
  if (step.error === true || (exitCode !== null && exitCode !== 0)) {
    const first = String(event.output ?? '').split(/\r?\n/).find(line => line.trim());
    const label = exitCode !== null ? `exit ${exitCode}` : 'failed';
    return { state: 'failed', exitCode, label: first ? `${label}: ${oneLine(first, 120)}` : label };
  }
  if (step.interrupted) return { state: 'interrupted', exitCode, label: 'interrupted' };
  if (step.error === false || step.done === true || event.done === true) return { state: 'ok', exitCode, label: 'ok' };
  return { state: 'unknown', exitCode, label: 'no result' };
}

/** A code fence longer than any backtick run in the text, so output containing ``` cannot close it early. */
function fenced(text, info = '') {
  const longest = Math.max(2, ...(String(text).match(/`+/g) || []).map(run => run.length));
  const bar = '`'.repeat(longest + 1);
  return `${bar}${info}\n${text}${String(text).endsWith('\n') ? '' : '\n'}${bar}\n`;
}

/**
 * Renders `chat` as Markdown and indexes it: `locate(message, offset)` says on which
 * line the character at `offset` of that message's text sits, so a briefing can point
 * at exactly the part it shortened. Messages are matched by identity.
 * @returns {{ text: string, locate: (message: object, offset?: number) => ({ turn: number, message: number, line: number } | null),
 *             turnOf: (user: object) => ({ turn: number, line: number, toolLine: number } | null) }}
 */
function renderTranscript(chat = {}) {
  const chunks = [];
  let line = 1;
  const emit = (text) => {
    chunks.push(text);
    for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) line += 1;
  };
  const messages = new Map(); // message -> { turn, number, segments: [{ start, end, line }] }
  const turnInfo = new Map(); // user message -> { turn, line, toolLine }

  emit(`# Clanker chat transcript: ${oneLine(chat.title, 120) || 'untitled chat'}\n\n`);
  emit(`- chat id: ${chat.id || 'unknown'}\n- started: ${chat.createdAt || 'unknown'}\n`);
  emit('- This is a complete plain-text copy of the chat: every user message, every assistant message, and every tool call with its full command, result and output.\n');
  emit(`- Tool output is stored as Clanker recorded it, which is at most ${RECORDED_OUTPUT_CHARS} characters per call; longer output is marked as truncated.\n`);
  emit('- Turns start with "## Turn N". Briefings point here by line number: read from that line with your file Read tool (offset and limit).\n\n');

  const stamp = (message) => [message.agent, message.modelLabel, message.at].filter(Boolean).join(' · ');
  turnsOf(chat.messages || []).forEach((turn, index) => {
    const number = index + 1;
    emit('\n---\n\n');
    const info = { turn: number, line, toolLine: 0 };
    turnInfo.set(turn.user, info);
    emit(`## Turn ${number} · ${oneLine(turn.user.text, 90) || '(no text)'}\n\n`);

    const userText = String(turn.user.text ?? '');
    emit('### User');
    emit(`${stamp(turn.user) ? ` · ${stamp(turn.user)}` : ''}\n\n`);
    messages.set(turn.user, { turn: number, number: 0, segments: [{ start: 0, end: userText.length, line }] });
    emit(`${userText}\n\n`);
    const files = (turn.user.attachments || []).map(file => (typeof file === 'string' ? file : file?.path || file?.name)).filter(Boolean);
    if (files.length) emit(`Attachments: ${files.join(', ')}\n\n`);

    // A tool belongs to the assistant message that was streaming when it started (`offset`: how much reply text came first).
    const toolsOf = new Map();
    let current = null;
    for (const item of turn.items) {
      if (item.role === 'assistant') { current = item; toolsOf.set(item, []); }
      else (toolsOf.get(current) || toolsOf.set(current, []).get(current)).push(item);
    }
    let toolNumber = 0;
    const emitTool = (step) => {
      const event = step.event || {};
      const status = toolStatus(step);
      toolNumber += 1;
      if (!info.toolLine) info.toolLine = line;
      emit(`#### Tool ${toolNumber} · ${event.name || 'tool'} · ${status.label}\n\n`);
      const command = String(event.command ?? '');
      if (command) emit(`Command:\n${fenced(command)}\n`);
      if (event.file && event.file !== command) emit(`File: ${event.file}\n\n`);
      if (event.diff) emit(`Diff:\n${fenced(event.diff, 'diff')}\n`);
      const output = String(event.output ?? '');
      if (output) emit(`Output${output.length >= RECORDED_OUTPUT_CHARS ? ` (truncated when recorded at ${RECORDED_OUTPUT_CHARS} characters)` : ''}:\n${fenced(output)}\n`);
      else emit('Output: (none recorded)\n\n');
    };

    toolsOf.get(null)?.forEach(emitTool);
    turn.answers.forEach((answer, n) => {
      const text = String(answer.text ?? '');
      const entry = { turn: number, number: n + 1, segments: [] };
      messages.set(answer, entry);
      emit(`### Message ${n + 1}${stamp(answer) ? ` · ${stamp(answer)}` : ''}${answer.interrupted ? ' · stopped by the user' : ''}${answer.checkpoint ? ' · compaction checkpoint' : ''}\n\n`);
      const steps = (toolsOf.get(answer) || []).map((step, order) => ({ step, order, at: Number.isFinite(step.offset) ? Math.min(Math.max(step.offset, 0), text.length) : text.length }))
        .sort((a, b) => a.at - b.at || a.order - b.order);
      let position = 0;
      const segment = (end) => {
        if (end <= position && entry.segments.length) return;
        entry.segments.push({ start: position, end, line });
        emit(`${text.slice(position, end)}\n\n`);
        position = end;
      };
      for (const { step, at } of steps) { segment(at); emitTool(step); }
      segment(text.length);
      if (answer.compactContext) emit(`#### Retained context (compaction)\n\n${answer.compactContext}\n\n`);
    });
  });

  const locate = (message, offset = 0) => {
    const entry = messages.get(message);
    if (!entry) return null;
    const { segments } = entry;
    const at = Math.max(0, offset);
    const found = segments.findLast(part => part.start <= at) || segments[0];
    const text = String(message.text ?? '');
    const within = text.slice(found.start, Math.min(at, found.end));
    return { turn: entry.turn, message: entry.number, line: found.line + (within.match(/\n/g) || []).length };
  };
  return { text: chunks.join(''), locate, turnOf: (user) => turnInfo.get(user) || null };
}

module.exports = { renderTranscript, turnsOf, toolStatus, oneLine, RECORDED_OUTPUT_CHARS };
