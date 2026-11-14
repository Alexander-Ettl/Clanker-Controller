'use strict';

// The real CliAccounts (the object behind the rail's rings) with only the CLI process faked, so the sign-in gate and the rail
// are tested on the one state they share. `status` is what each CLI's own status command says right now:
// 'connected' | 'signin' | 'broken' | 'missing' | 'unknown' (the check itself fails). Nothing here starts a real CLI.

const os = require('node:os');
const path = require('node:path');
const { CliAccounts } = require('../lib/cli-accounts');

const CRASH = 'Error: Missing optional dependency @openai/codex-win32-x64. Reinstall Codex: npm install -g @openai/codex@latest\n    at findCodexExecutable (file:///C:/npm/codex.js:107:9)';

function fakeAccounts({ agents = ['codex'], status = {}, signIn = async () => ({ ok: true }) } = {}) {
  const calls = { look: 0, signIn: 0, terminals: 0 };
  const state = { claude: 'connected', codex: 'connected', gemini: 'connected', ...status };
  const clock = { now: 1000, tick(ms) { this.now += ms; } };
  const messages = [];
  const agentOf = (file) => ['claude', 'codex', 'gemini'].find((agent) => file.includes(agent));
  const accounts = new CliAccounts({
    languageServer: async () => null, home: path.join(os.tmpdir(), 'clanker-no-home'), cwd: 'C:/Work', now: () => clock.now,
    store: { get: () => ({ enabled: agents, completed: true }), set: async () => {} },
    vscode: { window: { terminals: [], createTerminal: () => { calls.terminals++; return { show() {}, dispose() {} }; } } },
    find: (agent) => ({ path: state[agent] === 'missing' ? null : `C:/bin/${agent}.exe` }), reset() {}, broadcast: (message) => messages.push(message),
    run: async (file, args) => {
      const agent = agentOf(file);
      if (args.includes('status') || args[0] === 'models') {
        calls.look++;
        const now = state[agent];
        if (now === 'unknown') throw new Error('timed out');
        if (now === 'connected') return { ok: true, code: 0, stdout: agent === 'gemini' ? 'gemini-flash\tGemini Flash' : '{"loggedIn":true}' };
        return { ok: false, code: 1, stdout: '', stderr: now === 'broken' ? CRASH : 'Not logged in' };
      }
      calls.signIn++;
      return signIn(agent, state);
    },
  });
  return { accounts, state, calls, clock, messages };
}

module.exports = { fakeAccounts, CRASH };
