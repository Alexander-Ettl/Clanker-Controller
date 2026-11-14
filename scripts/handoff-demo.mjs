// Builds the cross-agent briefing for a real chat and proves that every shortened part can be read back.
//
//   node scripts/handoff-demo.mjs [--chat <id or title part>] [--last 12] [--agent codex] [--plain] [--max-chars 20000]
//                                 [--session-dir <dir>] [--out <dir>]
//
// The chat is only read. The transcript is written to a scratch session folder (--out, default: the OS temp
// folder), never into the live one. Without --chat the largest chat in the session folder is used.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ChatStore } = require('../ai-chat-panel/lib/chat-store.js');
const { buildHandoff, turnsOf } = require('../ai-chat-panel/lib/chat-handoff.js');

const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);

function findSessionDir() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  for (const editor of ['Antigravity IDE', 'Antigravity', 'Code']) {
    const dir = path.join(appData, editor, 'User', 'globalStorage', 'local.ai-chat-panel', 'session');
    if (fs.existsSync(path.join(dir, 'chats'))) return dir;
  }
  throw new Error('No Clanker session folder found; pass --session-dir.');
}

const sessionDir = option('session-dir', findSessionDir());
const chatsDir = path.join(sessionDir, 'chats');
const wanted = option('chat', '');
const candidates = fs.readdirSync(chatsDir).filter(name => name.endsWith('.json')).map(name => ({ name, size: fs.statSync(path.join(chatsDir, name)).size }));
const picked = wanted
  ? candidates.find(entry => entry.name.includes(wanted)) || candidates.find(entry => fs.readFileSync(path.join(chatsDir, entry.name), 'utf8').match(/"title":"([^"]*)"/)?.[1]?.toLowerCase().includes(wanted.toLowerCase()))
  : candidates.sort((a, b) => b.size - a.size)[0];
if (!picked) throw new Error(`No chat matches "${wanted}".`);

const chat = new ChatStore(sessionDir).load(picked.name.replace(/^\d+_/, '').replace(/\.json$/, ''));
const turns = turnsOf(chat.messages);
const last = Number(option('last', 12));
const firstUser = chat.messages.indexOf(turns[Math.max(0, turns.length - last)].user);
const missed = chat.messages.slice(firstUser);

const scratch = path.resolve(option('out', path.join(os.tmpdir(), 'clanker-handoff-demo')));
const transcript = new ChatStore(scratch).transcript(chat);
const handoff = buildHandoff(missed, option('agent', 'codex'), { structured: !args.includes('--plain'), maxChars: Number(option('max-chars', 20000)), transcript });

console.log(`chat:        ${chat.title || chat.id} (${(picked.size / 1e6).toFixed(1)} MB, ${chat.messages.length} messages, ${turns.length} turns)`);
console.log(`briefing:    last ${Math.min(last, turns.length)} turns, ${handoff.length} characters`);
console.log(`transcript:  ${transcript.file} (${(fs.statSync(transcript.file).size / 1e6).toFixed(1)} MB)`);
console.log('\n================ BRIEFING AS THE RECEIVING AGENT SEES IT ================\n');
console.log(handoff);
console.log('\n================ DOES EVERY POINTER LEAD TO THE OMITTED TEXT? ================\n');

const lines = fs.readFileSync(transcript.file, 'utf8').split('\n');
const markers = [...handoff.matchAll(/\[\.\.\.([^\]]*?); full (?:text|commands, exit status and output): (\S.*?) line (\d+), turn (\d+)(?:-\d+)?(?:, (message \d+|user message))?\.\.\.\]/g)];
const shorten = (text) => (text.length > 150 ? `${text.slice(0, 150)}…` : text);
let resolved = 0;
let checked = 0;
for (const [index, [marker, omitted, file, line, turn, which]] of markers.entries()) {
  const number = Number(line);
  const sameFile = path.resolve(file) === path.resolve(transcript.file);
  const target = lines[number - 1] || '';
  // The pointed line must be chat text that belongs to that turn and message.
  let genuine = null;
  if (which) {
    const owner = turns[Number(turn) - 1];
    const text = which === 'user message' ? owner?.user.text : owner?.answers[Number(which.split(' ')[1]) - 1]?.text;
    genuine = Boolean(target.trim()) && String(text || '').includes(target);
    checked += 1;
    if (genuine) resolved += 1;
  }
  if (!which) {
    // A range of turns or a tool list: the pointed line must be that turn's heading or its first tool block.
    genuine = target.startsWith(/tool/.test(omitted) ? '#### Tool 1 ' : `## Turn ${turn} `);
    checked += 1;
    if (genuine) resolved += 1;
  }
  if (index < 6 || genuine === false) {
    console.log(`marker ${index + 1}: ${omitted} -> turn ${turn}${which ? `, ${which}` : ''}, line ${number}${sameFile ? '' : ' (DIFFERENT FILE)'}${genuine === false ? '   <-- DOES NOT MATCH' : ''}`);
    for (let at = Math.max(1, number - 1); at <= number + 2; at += 1) console.log(`  ${String(at).padStart(6)}${at === number ? ' >' : '  '} ${shorten(lines[at - 1] ?? '')}`);
  }
}
console.log(`\n${markers.length} markers in the briefing; ${resolved} of ${checked} pointers land on the right line (message text, turn heading or first tool block).`);
if (resolved !== checked) process.exitCode = 1;
