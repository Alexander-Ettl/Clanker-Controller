'use strict';

// Text Clanker adds around a turn's prompt. The CLI does the work (runs the tests, reads the code, edits the
// files); these only tell it what to do. Nothing here is stored in the chat: the transcript keeps what you typed.

const PLAN_LIMIT = 40000; // characters of plan carried into the build turn

/** Auto-Verify: the check runs inside the turn that made the change, with the CLI's own shell tool. */
function verifyInstruction(command) {
  const clean = String(command || '').replace(/[`\r\n]+/g, ' ').trim().slice(0, 200);
  const how = clean ? `run \`${clean}\`` : "run the project's own test or verify command (see its scripts and rules files)";
  return `[Auto-Verify] If you changed files this turn, ${how} before you finish. If it fails, read the error, fix the cause and run it again (two fix rounds at most), then say plainly what the result was. If you changed nothing, skip this.`;
}

/** Architect turn: a plan and nothing else, so a second model can build it. */
const ARCHITECT_PREFIX = '[Architect] Plan only: do not edit, create or delete files, and run nothing that changes anything. Read what you need, then write a numbered implementation plan another engineer can follow without asking you questions: which files change, what changes in each, the edge cases, and how to check the result. Task:';

/** Editor turn: the architect's plan, handed over whole. */
function buildInstruction(plan, task) {
  const text = String(plan || '').trim();
  const body = text.length > PLAN_LIMIT ? `${text.slice(0, PLAN_LIMIT)}\n… (plan cut here)` : text;
  return `[Editor] Implement this plan. Follow it; if a step is wrong or impossible, say so and change as little as needed.\n\nPLAN:\n${body}\n\nORIGINAL TASK:\n${String(task || '').trim()}`;
}

/** "/architect refactor the header": the task after the command, or null when this isn't that command. */
function parseArchitect(text) {
  const match = /^\/architect(?:\s+([\s\S]+))?$/i.exec(String(text || '').trim());
  return match ? (match[1] || '').trim() : null;
}

module.exports = { verifyInstruction, ARCHITECT_PREFIX, buildInstruction, parseArchitect };
