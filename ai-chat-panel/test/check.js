'use strict';

// P17-U: syntax check for every extension, lib, and media script. Parses
// in-process (no `node --check` subprocess per file), prints nothing on
// success, and names the file and error on failure.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const files = ['extension.js', ...['lib', 'media', 'test'].flatMap((dir) => fs.readdirSync(path.join(root, dir)).filter((name) => /\.js$/.test(name)).map((name) => `${dir}/${name}`))];

let failed = 0;
for (const file of files) {
  const source = fs.readFileSync(path.join(root, file), 'utf8').replace(/^#!.*/, '');
  try {
    // The CommonJS wrapper, so top-level `return` and `require` parse as they do in Node.
    new vm.Script(`(function (exports, require, module, __filename, __dirname) {${source}\n})`, { filename: file });
  } catch (error) {
    failed += 1;
    console.error(`${file}: ${error.message}`);
  }
}
if (failed) process.exitCode = 1;
