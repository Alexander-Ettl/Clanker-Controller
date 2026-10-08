'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { attachmentPrompt } = require('../lib/attachments');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-documents-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return (name, content) => { const file=path.join(root,name); fs.writeFileSync(file,content); return file; };
}
const previews = prompt => JSON.parse(prompt.split('Attached document previews (JSON):\n')[1]);
test('JSON feedback and other text documents arrive as content, not just pointers', t => {
  const put=fixture(t), json=JSON.stringify({version:1,feedback:[{better_model:'gemini',note:'Documentation'}]});
  const a=put('feedback with spaces.json',json), b=put('notes.md','# Notes\nKeep this text.');
  const prompt=attachmentPrompt('Review my feedback',[a,b]);
  assert.deepEqual(previews(prompt).map(d=>d.content),[json,'# Notes\nKeep this text.']);
  assert.deepEqual(previews(prompt).map(d=>d.truncated),[false,false]);
  assert.ok(prompt.includes(a)); assert.ok(prompt.includes(b));
  assert.equal(fs.readFileSync(a,'utf8'),json);
});
test('large previews stay bounded and instruct the destination to read the original', t => {
  const put=fixture(t), files=Array.from({length:5},(_,i)=>put(`${i}.txt`,'x'.repeat(100000)));
  const prompt=attachmentPrompt('Read all files',files), docs=previews(prompt);
  assert.ok(docs.every(d=>d.content.length<=8192 && d.truncated));
  assert.equal(docs.reduce((n,d)=>n+d.content.length,0),24576);
  for (const file of files) assert.ok(prompt.includes(file), 'every original remains accessible after the preview budget runs out');
  assert.match(prompt,/open the original local path/);
});
test('binary, missing and image attachments retain pointers without fake text previews', t => {
  const put=fixture(t), pdf=put('report.pdf',Buffer.from([0,255,128,1])), image=put('screen.png','image bytes');
  const missing=path.join(path.dirname(pdf),'missing.json');
  const prompt=attachmentPrompt('Inspect attachments',[pdf,image,missing]);
  for(const file of [pdf,image,missing])assert.ok(prompt.includes(file));
  assert.ok(!prompt.includes('Attached document previews'));
  assert.match(prompt,/Open and inspect the attached original image/);
});
test('UTF-16 text is decoded and invalid text bytes fall back to the original path', t => {
  const put=fixture(t), utf16=put('unicode.txt',Buffer.concat([Buffer.from([255,254]),Buffer.from('Grüße','utf16le')]));
  const invalid=put('invalid.json',Buffer.from([255,255,0,128]));
  const prompt=attachmentPrompt('Read',[utf16,invalid]);
  assert.equal(previews(prompt).length,1);assert.equal(previews(prompt)[0].content,'Grüße');
  assert.ok(prompt.includes(invalid));
});
test('plain requests remain untouched',()=>assert.equal(attachmentPrompt('Hello'), 'Hello'));
