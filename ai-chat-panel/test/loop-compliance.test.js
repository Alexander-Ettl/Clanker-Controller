'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { redactPersonalData, redactText, scanCompliance, validIban } = require('../lib/loop-compliance');

const files = entries => new Map(Object.entries(entries));
const titles = findings => findings.map(finding => finding.title);

test('personal data is replaced inside its line and line numbers stay valid', () => {
  const body = ['const a = 1;', 'mail("anna.schmidt@firma.de");', 'const iban = "DE02120300000000202051";', 'call("+49 171 1234567");', 'end'].join('\n');
  const out = redactPersonalData(files({ 'src/a.js': body }));
  const lines = out.contents.get('src/a.js').split('\n');
  assert.equal(lines.length, 5);
  assert.equal(lines[1], 'mail("[email]");');
  assert.equal(lines[2], 'const iban = "[iban]";');
  assert.equal(lines[3], 'call("[phone]");');
  assert.deepEqual(out.counts, { email: 1, iban: 1, phone: 1 });
  assert.equal(body.includes('anna.schmidt'), true, 'the input is not changed');
});

test('examples, file names and look-alikes are not personal data', () => {
  const text = [
    'user@example.com test@localhost img@2x.png logo@3x.webp "@scope/pkg" pkg@1.2.3 noreply@users.noreply.github.com',
    'DE89 3704 0044 0532 0130 00 AB12 CDEF GHIJ KLMN',
    'const n = 20240131; const price = 1234567; 2024-01-31 12:30:45',
  ].join('\n');
  const out = redactPersonalData(files({ 'a.js': text }));
  assert.equal(out.total, 0);
  assert.equal(out.contents.get('a.js'), text);
});

test('IBAN needs a valid checksum', () => {
  assert.equal(validIban('DE02 1203 0000 0000 2020 51'), true);
  assert.equal(validIban('DE02 1203 0000 0000 2020 52'), false);
  assert.equal(validIban('DE89370400440532013000'), false, 'documentation example');
});

test('redactText covers diffs and command output', () => {
  assert.equal(redactText('+  to: "max@kunde.io"'), '+  to: "[email]"');
});

test('remote fonts, trackers, CDNs and embeds are found with their lines', () => {
  const findings = scanCompliance(files({
    'index.html': ['<html><body>', '<link href="https://fonts.googleapis.com/css2?family=Inter" rel="stylesheet">',
      '<script src="https://cdn.jsdelivr.net/npm/x/dist/x.js"></script>', '<iframe src="https://www.youtube.com/embed/abc"></iframe>',
      '<script src="https://www.googletagmanager.com/gtag/js?id=G-1"></script>', '<a href="/impressum">Impressum</a> <a href="/datenschutz">Datenschutz</a></body></html>'].join('\n'),
  }));
  const names = titles(findings);
  assert.ok(names.includes('Fonts are loaded from Google servers'));
  assert.ok(names.includes('Tracking or analytics script is loaded'));
  assert.ok(names.includes('Scripts or styles are loaded from a public CDN'));
  assert.ok(names.includes('Third-party embed loads without a click'));
  assert.equal(findings[0].severity, 'high');
  assert.equal(findings.find(f => f.title.startsWith('Fonts')).evidence[0].line, 2);
  assert.ok(findings.every(f => f.suggestion && f.kind === 'compliance' && f.source === 'compliance' && f.aspects[0] === 'compliance'));
  assert.ok(!names.includes('No legal notice (Impressum) found') && !names.includes('No privacy notice (Datenschutzerklärung) found'));
});

test('a tracker in a file that handles consent is only a reminder to check', () => {
  const [finding] = scanCompliance(files({ 'src/consent.js': 'if (consent.analytics) loadScript("https://www.googletagmanager.com/gtag/js");' }));
  assert.equal(finding.severity, 'medium');
  assert.equal(finding.status, 'suspected');
});

test('a site without imprint or privacy page is flagged, a library is not', () => {
  const site = scanCompliance(files({ 'index.html': '<body><a href="/about">About</a></body>' }));
  assert.deepEqual(titles(site).sort(), ['No legal notice (Impressum) found', 'No privacy notice (Datenschutzerklärung) found']);
  assert.equal(site.find(f => f.title.startsWith('No privacy')).severity, 'high');
  assert.deepEqual(scanCompliance(files({ 'src/lib.js': 'export const add = (a, b) => a + b;' })), []);
});

test('a form that asks for contact details needs a privacy note nearby', () => {
  const site = { 'index.html': '<body><a href="/impressum">I</a><a href="/datenschutz">D</a></body>' };
  const bare = '<form><input type="email" name="email"><button>Send</button></form>';
  assert.ok(titles(scanCompliance(files({ ...site, 'contact.html': bare }))).includes('Form collects personal data without a privacy notice'));
  const noted = bare.replace('<button>', '<p>Siehe Datenschutz</p><button>');
  assert.ok(!titles(scanCompliance(files({ ...site, 'contact.html': noted }))).includes('Form collects personal data without a privacy notice'));
});

test('personal data in logs and http:// forms are indicators; tests and docs are ignored', () => {
  const findings = scanCompliance(files({
    'src/auth.js': 'function login(req) {\n  console.log("login", req.body.email);\n}',
    'page.html': '<a href="/impressum">i</a><a href="/datenschutz">d</a><form action="http://shop.example/pay"></form>',
    'test/auth.test.js': 'console.log(email); fetch("https://fonts.googleapis.com/css")',
    'docs/notes.md': 'We use fonts.googleapis.com',
  }));
  const names = titles(findings);
  assert.ok(names.includes('Personal data may be written to logs'));
  assert.ok(names.includes('Resource or form uses unencrypted http://'));
  assert.ok(!names.includes('Fonts are loaded from Google servers'));
});

test('stored personal data is reported without its value', () => {
  const redacted = redactPersonalData(files({ 'seed.js': 'const owner = "anna.schmidt@firma.de";' }));
  const finding = scanCompliance(files({ 'seed.js': 'const owner = "anna.schmidt@firma.de";' }), redacted).find(f => f.title.startsWith('Real-looking personal data'));
  assert.ok(finding);
  assert.ok(!JSON.stringify(finding).includes('anna.schmidt'));
  assert.equal(finding.evidence[0].line, 1);
});
