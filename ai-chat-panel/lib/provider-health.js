'use strict';

// A CLI that exits without a reply because its output no longer looks like what Clanker parses (a renamed event, a new format)
// used to end the turn silently: an empty answer with nothing to act on. This is the message that goes into the chat instead.

const NAMES = { claude: 'Claude Code', codex: 'Codex', gemini: 'Antigravity', copilot: 'GitHub Copilot' };

/**
 * The text for a turn that ended with no reply, or '' when the usual handling is enough.
 * `unrecognized`: JSON lines the CLI printed that matched no event Clanker knows; `diagnostic`: the CLI's last stderr line (it
 * is shown as it is: a sign-in or quota message is the useful part, and Clanker's auth gate reads those).
 */
function silentTurnMessage({ agent, code = 0, unrecognized = 0, diagnostic = '' }) {
  const name = NAMES[agent] || agent;
  const said = String(diagnostic || '').trim();
  if (said) return '';                            // the CLI explained itself; extension code shows that
  if (code && !unrecognized) return '';           // a plain crash: "exited with code N" says it
  const seen = unrecognized ? ` It printed ${unrecognized} line${unrecognized === 1 ? '' : 's'} that Clanker does not recognise,` : '';
  return `${name} ended without a reply.${seen || ' It printed nothing Clanker could use,'} which usually means it is signed out or the CLI changed its output format. Check the rail for a red ring, update ${name} and Clanker, and open "Clanker Controller: Show Logs" for the raw output.`;
}

module.exports = { silentTurnMessage };
