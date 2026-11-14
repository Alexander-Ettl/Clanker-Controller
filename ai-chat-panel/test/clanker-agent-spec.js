'use strict';

// The worker's `spec` seam (CLANKER_AGENT_SPEC_MODULE): runs clanker-agent-fake.js in the mode named by the task's prompt.
const path = require('node:path');
module.exports = (request, { prompt }) => {
  const mode = /MODE:(ok|fail|hang)/.exec(prompt)?.[1] || 'ok';
  return { command: process.execPath, args: [path.join(__dirname, 'clanker-agent-fake.js'), mode], env: {}, input: '' };
};
