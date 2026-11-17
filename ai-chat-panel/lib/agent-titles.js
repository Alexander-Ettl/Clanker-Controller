'use strict';

// A chat's name as the agent itself wrote it. Antigravity (agy) saves one per conversation in
// ~/.gemini/antigravity-cli/annotations/<conversation id>.pbtxt (protobuf text: `title:"..."`).
// Claude Code names only interactive sessions and Codex names only its own app's threads, so for
// the chats Clanker runs through them nothing is on disk and Groq (voice-router) names the chat.

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_TITLE = 80;

/** Protobuf text escapes: \" \\ \n \t \r \' and \ooo / \xhh bytes (non-ASCII text is written as UTF-8 bytes). */
function unescapeProtoText(text) {
  const bytes = [];
  const push = (value) => { for (const byte of Buffer.from(value, 'utf8')) bytes.push(byte); };
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '\\') { push(text[i]); continue; }
    const next = text[i + 1] ?? '';
    const octal = /^[0-7]{1,3}/.exec(text.slice(i + 1, i + 4));
    const hex = /^x[0-9a-fA-F]{1,2}/.exec(text.slice(i + 1, i + 4));
    if (octal) { bytes.push(parseInt(octal[0], 8) & 0xff); i += octal[0].length; }
    else if (hex) { bytes.push(parseInt(hex[0].slice(1), 16)); i += hex[0].length; }
    else { push({ n: '\n', t: '\t', r: '\r' }[next] ?? next); i += 1; }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** The title in an annotation file, or '' (no title field, or only whitespace). */
function parseAnnotationTitle(pbtxt) {
  const match = /(?:^|\s)title:\s*"((?:[^"\\]|\\.)*)"/.exec(String(pbtxt || ''));
  if (!match) return '';
  return unescapeProtoText(match[1]).replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE).trim();
}

const agyAnnotationsDir = () => path.join(os.homedir(), '.gemini', 'antigravity-cli', 'annotations');

/** Antigravity's own title for a conversation, or '' while it hasn't written one (it appears partway through the first turn). */
async function readAgyTitle(conversationId, { dir = agyAnnotationsDir() } = {}) {
  // The id came from agy's stream, but it becomes part of a path here.
  if (!/^[0-9a-f-]{8,64}$/i.test(String(conversationId || ''))) return '';
  try { return parseAnnotationTitle(await fs.promises.readFile(path.join(dir, `${conversationId}.pbtxt`), 'utf8')); }
  catch { return ''; }
}

// Agents whose own title can be read, keyed by the id of the chat's session in chat.sessions.
const AGENT_TITLES = { gemini: readAgyTitle };
const hasAgentTitles = (agent) => Object.hasOwn(AGENT_TITLES, agent);
const readAgentTitle = (agent, sessionId, options) => (hasAgentTitles(agent) ? AGENT_TITLES[agent](sessionId, options) : Promise.resolve(''));

module.exports = { parseAnnotationTitle, readAgyTitle, readAgentTitle, hasAgentTitles, unescapeProtoText };
