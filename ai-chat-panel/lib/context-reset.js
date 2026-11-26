'use strict';

/**
 * Every way a chat's context can shrink behind the user's back, in words.
 * The history divider ("Context auto-compacted") shows one of these whenever it
 * happens without the Compact button:
 *   native   the CLI compacted its own session (Claude Code, Codex)
 *   session  Clanker started a fresh CLI session, briefed from the chat (routing: context threshold, provider change)
 *   resume   the CLI could not resume its session, so a fresh one took over
 *   drop     the gauge fell sharply and nothing said why (Gemini compacts without a signal)
 */
const AGENT_NAMES = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', copilot: 'Copilot' };
const KINDS = new Set(['native', 'session', 'resume', 'drop']);

const kTokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : `${Math.max(1, Math.round(n / 1000))}k`);
const agentName = (agent) => AGENT_NAMES[agent] || 'The CLI';

/** Routing reasons (lib/routing.js continuity) that lose a session the user did not ask to lose; the others are deliberate. */
const SESSION_REASONS = {
  'target context threshold': ({ tokens, limit, pct, name }) => `This chat had filled ${pct}% of ${name}'s window${tokens && limit ? ` (${kTokens(tokens)} of ${kTokens(limit)})` : ''}, which is the "Start a new session at" limit in Settings. A fresh ${name} session was briefed from the chat.`,
  'provider changed': ({ name }) => `The model changed vendor, so ${name} starts a fresh session briefed from the chat.`,
  'unrelated task': ({ name }) => `The router judged this an unrelated task, so ${name} starts a fresh session briefed from the chat.`,
};

/** `{ title, detail }` for one reset, or null when it is not one worth a divider. */
function describeContextReset(info = {}) {
  if (!KINDS.has(info.kind)) return null;
  const name = agentName(info.agent);
  if (info.kind === 'native') {
    const was = info.preTokens > 0 ? ` It held ${kTokens(info.preTokens)} tokens.` : '';
    return { title: `Context auto-compacted by ${name}`, detail: `${name} ran out of room and summarised its own session; it carries on from that summary.${was}` };
  }
  if (info.kind === 'session') {
    const text = SESSION_REASONS[info.reason];
    if (!text) return null; // 'user requested' and 'always new' are the user's own choice
    const pct = info.limit > 0 ? Math.round((info.tokens / info.limit) * 100) : 0;
    return { title: 'New session · context reset', detail: text({ name, tokens: info.tokens, limit: info.limit, pct }) };
  }
  if (info.kind === 'resume') return { title: 'New session · context reset', detail: `${name} could not resume its previous session, so a fresh one was briefed from the chat.` };
  return { title: 'Context shrank', detail: `${name} now holds ${kTokens(info.after)} tokens, down from ${kTokens(info.before)}. It most likely compacted its own history.` };
}

/** True when `after` is a drop no ordinary turn explains. */
function isContextDrop(before, after) {
  return before >= 40000 && after > 0 && after < before * 0.5;
}

module.exports = { describeContextReset, isContextDrop, kTokens };
