'use strict';

const path = require('node:path');
const os = require('node:os');

// AGY omits ask_question from stream-json (step_type: unknown). The original
// tool call is still stored in its local SQLite trajectory, as a protobuf Step.
function fields(bytes) {
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
    if (wire === 0) { varint(); continue; }
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

function readQuestion(conversationId, stepIndex) {
  if (!/^[a-f0-9-]{36}$/i.test(conversationId || '') || !Number.isSafeInteger(stepIndex) || stepIndex < 0) return null;
  const databasePath = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'conversations', `${conversationId}.db`);
  return readDatabase(databasePath, stepIndex);
}

module.exports = { readQuestion, decodeQuestion };
