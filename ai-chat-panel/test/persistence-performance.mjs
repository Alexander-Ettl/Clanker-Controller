// Synthetic storage only. Never reads or migrates the user's actual conversations.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const { ChatStore } = createRequire(import.meta.url)('../lib/chat-store');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-persistence-bench-'));
const median = samples => samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)];
const time = fn => { const start = performance.now(); fn(); return performance.now() - start; };
try {
  const store = new ChatStore(root), chat = store.create();
  chat.messages = Array.from({ length: 100 }, (_, i) => [
    { role: 'user', text: `Review change ${i}` },
    { role: 'assistant', text: 'Verified the implementation.', agent: 'codex' },
    { role: 'tool', event: { name: 'Read', file: `C:/project/change-${i}.js`, output: Array.from({ length: 1200 }, (_, line) => `change ${i} line ${line}: const result = verifyImplementation(input);\n`).join('') } },
  ]).flat();
  const legacy = path.join(root, 'legacy.json');
  fs.writeFileSync(legacy, JSON.stringify(chat));
  const legacyOpen = Array.from({ length: 7 }, () => time(() => JSON.parse(fs.readFileSync(legacy, 'utf8'))));
  store.save(chat);
  const file = store.fileFor(chat.id);
  const lazyOpen = Array.from({ length: 7 }, () => time(() => new ChatStore(root).load(chat.id)));
  const saves = Array.from({ length: 7 }, (_, i) => time(() => { chat.draft = `draft ${i}`; store.save(chat); }));
  const compressedBytes = fs.readdirSync(store.outputs.dir).reduce((sum, name) => sum + fs.statSync(path.join(store.outputs.dir, name)).size, 0);
  const results = { note: '100 synthetic exchanges, one large unique tool output each. Median of seven warm filesystem samples. Legacy comparison is read+JSON parse only; lazy open defers tool decoding. Save includes backup, write and fsync. Excludes IDE transport and rendering.',
    exchanges: 100, legacySnapshotBytes: fs.statSync(legacy).size, snapshotBytes: fs.statSync(file).size, compressedOutputBytes: compressedBytes,
    snapshotAndOutputBytes: fs.statSync(file).size + compressedBytes,
    legacyOpenMedianMs: median(legacyOpen), lazyOpenMedianMs: median(lazyOpen), checkpointPreparationAndSyncSaveMedianMs: median(saves) };
  fs.mkdirSync('out/persistence-performance', { recursive: true });
  fs.writeFileSync('out/persistence-performance/benchmark.json', JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally { fs.rmSync(root, { recursive: true, force: true }); }
