'use strict';

const path = require('node:path');
const os = require('node:os');

// AGY omits ask_question from stream-json (step_type: unknown). The original
// tool call is still stored in its local SQLite trajectory, as a protobuf Step.
function fields(bytes, ints = null) {
  const result = new Map();
  let offset = 0;
  const varint = () => {
    let value = 0;
    for (let shift = 0; shift < 56 && offset < bytes.length; shift += 7) {
      const byte = bytes[offset++];
      value += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) return value;
    }
    throw new Error('Invalid AGY protobuf varint');
  };
  while (offset < bytes.length) {
    const tag = varint();
    const wire = tag % 8;
    if (wire === 0) { const value = varint(); if (ints) ints.set(Math.floor(tag / 8), value); continue; }
    const length = wire === 2 ? varint() : wire === 1 ? 8 : wire === 5 ? 4 : -1;
    if (length < 0 || offset + length > bytes.length) throw new Error('Invalid AGY protobuf field');
    if (wire === 2) result.set(Math.floor(tag / 8), bytes.subarray(offset, offset + length));
    offset += length;
  }
  return result;
}

function decodeQuestion(payload) {
  const metadata = fields(payload).get(5);
  const call = metadata && fields(metadata).get(4);
  if (!call) return null;
  const tool = fields(call);
  if (tool.get(2)?.toString('utf8') !== 'ask_question') return null;
  const params = JSON.parse(tool.get(3)?.toString('utf8') || '{}');
  return Array.isArray(params.questions) ? params.questions : null;
}

function readDatabase(databasePath, stepIndex) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = db.prepare('SELECT step_payload FROM steps WHERE idx = ?').get(stepIndex);
    return row ? decodeQuestion(Buffer.from(row.step_payload)) : undefined;
  } finally { db.close(); }
}

// A model step (step_type 15) holds the thinking summary Gemini wrote before its tool calls: field 20, sub-field 3.
// agy's stream-json never carries it, so it is read from the same trajectory file.
const USER_STEP = 14;
const PLANNER_STEP = 15;
function decodeThought(payload) {
  const planner = fields(payload).get(20);
  return planner ? (fields(planner).get(3)?.toString('utf8') || '').trim() : '';
}

const CONVERSATION_ID = /^[a-f0-9-]{36}$/i;
/** agy's trajectory file for a conversation, opened read-only; the caller closes it. Null for an id that is not a conversation id. */
function openConversation(conversationId) {
  if (!CONVERSATION_ID.test(conversationId || '')) return null;
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(path.join(os.homedir(), '.gemini', 'antigravity-cli', 'conversations', `${conversationId}.db`), { readOnly: true });
}

/** New thinking summaries of the current turn with a step index above `after` and below `before`, oldest first: [{ idx, text }]. */
function readThoughts(conversationId, after, before) {
  if (!Number.isSafeInteger(after) || !Number.isSafeInteger(before)) return [];
  const db = openConversation(conversationId);
  if (!db) return [];
  try {
    // A resumed conversation's file holds every earlier turn's thinking too: this turn starts at its last user message.
    const turnStart = db.prepare('SELECT MAX(idx) AS idx FROM steps WHERE step_type = ? AND idx < ?').get(USER_STEP, before)?.idx ?? -1;
    const rows = db.prepare('SELECT idx, step_payload FROM steps WHERE step_type = ? AND idx > ? AND idx < ? ORDER BY idx').all(PLANNER_STEP, Math.max(after, turnStart), before);
    return rows.map((row) => ({ idx: row.idx, text: decodeThought(Buffer.from(row.step_payload)) })).filter((entry) => entry.text);
  } finally { db.close(); }
}

// Every model call is saved in the trajectory's gen_metadata table. Its usage message (field 1.4) holds the call's
// fresh input (2), output (3) and cache-read (5) tokens; their sum is what the conversation weighed at that call.
// agy compacts a conversation itself at the budget in field 1.9.10.4 (512,000 for Gemini 4), so that is the real window.
// The stream's own step usage carries only the fresh part (a few thousand), never the cached history.
function decodeContext(payload) {
  const usage = fields(payload).get(1);
  const message = usage && fields(usage).get(4);
  if (!message) return null;
  const ints = new Map();
  fields(message, ints);
  const tokens = (ints.get(2) || 0) + (ints.get(3) || 0) + (ints.get(5) || 0);
  if (!tokens) return null;
  const limitMessage = fields(usage).get(9) && fields(fields(usage).get(9)).get(10);
  const limitInts = new Map();
  if (limitMessage) fields(limitMessage, limitInts);
  const limit = limitInts.get(4);
  return { tokens, ...(limit >= 32000 ? { limit } : {}) };
}

/** What the conversation weighs now, from its last model call: { tokens, limit? }, or null before the first call. */
function readContext(conversationId) {
  const db = openConversation(conversationId);
  if (!db) return null;
  try {
    for (const row of db.prepare('SELECT data FROM gen_metadata WHERE length(data) > 0 ORDER BY idx DESC LIMIT 3').all()) {
      let context = null;
      try { context = decodeContext(Buffer.from(row.data)); } catch { /* a row in another layout: try the one before */ }
      if (context) return context;
    }
    return null;
  } finally { db.close(); }
}

function readQuestion(conversationId, stepIndex) {
  if (!/^[a-f0-9-]{36}$/i.test(conversationId || '') || !Number.isSafeInteger(stepIndex) || stepIndex < 0) return null;
  const databasePath = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'conversations', `${conversationId}.db`);
  return readDatabase(databasePath, stepIndex);
}

module.exports = { readQuestion, decodeQuestion, readThoughts, decodeThought, readContext, decodeContext };
