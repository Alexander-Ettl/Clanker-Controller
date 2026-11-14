'use strict';

// A stand-in for a vendor CLI, used by clanker-agent.test.js. It prints Claude-style stream-json lines.
//   node clanker-agent-fake.js ok     -> a partial message, then the final result
//   node clanker-agent-fake.js fail   -> a partial message, then exits 1 saying the sign-in is gone
//   node clanker-agent-fake.js hang   -> a partial message, then waits for ever
const mode = process.argv[2];
const say = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
say({ type: 'assistant', message: { content: [{ type: 'text', text: 'Half an answer so far.' }] } });
if (mode === 'ok') {
  setTimeout(() => { say({ type: 'result', result: 'Finding one.\n\n## Sources\n- [READ] https://example.com/a\n- [SNIPPET] https://example.com/b\n- [BLOCKED] https://example.com/c (403)', usage: { input_tokens: 10, output_tokens: 5 } }); process.exit(0); }, 150);
} else if (mode === 'fail') {
  setTimeout(() => { process.stderr.write('Error: 401 Unauthorized, please log in again\n'); process.exit(1); }, 150);
} else setInterval(() => {}, 1000);
