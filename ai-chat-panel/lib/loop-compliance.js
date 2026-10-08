'use strict';

// EU compliance helpers for the full loop. Two jobs, neither of which costs a model token:
//
//   redactPersonalData   the scouts and verifiers are cloud models, usually run by a US company, so the text they are sent should
//                        not carry real people's e-mail addresses, IBANs or phone numbers. Matches are replaced inside their line
//                        (line numbers stay valid); the private checkout the editors work in is never changed.
//   scanCompliance       well-known technical indicators of GDPR / TDDDG problems in a web project: remote fonts, trackers, CDNs,
//                        embeds, a missing legal notice or privacy page, forms without a privacy notice, personal data in logs.
//
// These are indicators for a human to judge, not legal conclusions. Findings are suggestions: never changed automatically.

const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|spec|e2e|fixtures?|docs?)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const MARKUP = /\.(?:html?|astro|vue|svelte|[jt]sx|php|ejs|hbs|njk|liquid|mdx?|css|scss|less)$/i;
const CODE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro|html?|php|py|rb|go|java|kt|cs|swift)$/i;
const PAGE = /\.(?:html?|astro|vue|svelte|php|ejs|hbs|njk|liquid)$/i;

// ---- personal data in the text sent to cloud models -------------------------------------------------------------------------

const FILE_ENDING = /^(?:png|jpe?g|gif|svg|webp|avif|ico|css|scss|js|mjs|cjs|jsx|tsx?|json|html?|woff2?|ttf|otf|map|mp[34]|webm|pdf)$/i;
const SAFE_DOMAIN = /(?:^|\.)(?:example\.(?:com|org|net)|localhost|invalid|test|local|users\.noreply\.github\.com)$/i;
const EMAIL = /[A-Za-z0-9._%+-]{1,64}@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.([A-Za-z]{2,24}))\b/g;
const IBAN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g;
const PHONE = /(?:\+|00)[1-9]\d{0,2}[ -]?\(?\d{1,5}\)?(?:[ -]?\d{2,}){2,}|\b0[1-9]\d{1,4}[ /-]\d{4,}(?:[ -]\d{1,5})?\b/g;
const ANY = new RegExp(`(${EMAIL.source})|(${IBAN.source})|${PHONE.source}`, 'g');
// Documentation examples are not real accounts.
const EXAMPLE_IBAN = new Set(['DE89370400440532013000', 'GB82WEST12345698765432', 'FR1420041010050500013M02606']);

/** ISO 7064 mod 97-10, so ordinary words and ids shaped like an IBAN are not mistaken for one. */
function validIban(raw) {
  const text = raw.replace(/ /g, '');
  if (text.length < 15 || text.length > 34 || EXAMPLE_IBAN.has(text)) return false;
  let remainder = 0;
  for (const char of `${text.slice(4)}${text.slice(0, 4)}`) {
    const value = char >= 'A' ? char.charCodeAt(0) - 55 : Number(char);
    remainder = Number(`${remainder}${value}`) % 97;
  }
  return remainder === 1;
}
const realEmail = (domain, ending) => !SAFE_DOMAIN.test(domain) && !FILE_ENDING.test(ending) && !/^\d+x$/i.test(domain.split('.')[0]);
const digits = text => text.replace(/\D/g, '').length;

/** `Map(file -> text)` with personal data replaced by [email], [iban] and [phone], plus what was found. Pure: the input is not changed. */
function redactPersonalData(contents) {
  const counts = { email: 0, iban: 0, phone: 0 };
  const found = [];
  const out = new Map();
  for (const [file, body] of contents) {
    if (TEST_PATH.test(file) && !/\.(?:html?|astro)$/i.test(file)) { out.set(file, body); continue; }
    let changed = false;
    const lines = body.split('\n').map((line, index) => {
      if (line.length > 4000) return line;
      let next = line;
      const note = kind => { counts[kind]++; changed = true; if (found.length < 40) found.push({ file, line: index + 1, kind }); };
      // One pass, so a text taken as an IBAN (even a documentation example) is never read again as a phone number.
      next = next.replace(ANY, (match, email, domain, ending, iban) => {
        if (email) return realEmail(domain, ending) ? (note('email'), '[email]') : match;
        if (iban) return validIban(match) ? (note('iban'), '[iban]') : match;
        return digits(match) >= 8 && digits(match) <= 15 && !/^\d{4}-\d{2}-\d{2}/.test(match) ? (note('phone'), '[phone]') : match;
      });
      return next;
    });
    out.set(file, changed ? lines.join('\n') : body);
  }
  return { contents: out, counts, found, total: counts.email + counts.iban + counts.phone };
}

// ---- indicators --------------------------------------------------------------------------------------------------------------

const HANDOFF = 'Do not write legal text (privacy policy, imprint, consent wording): leave a clearly marked TODO for the site operator and a lawyer. Make the smallest technical change and keep every other behavior unchanged.';
const RULES = [
  { id: 'fonts', files: MARKUP, test: /fonts\.(?:googleapis|gstatic)\.com/i, severity: 'high',
    title: 'Fonts are loaded from Google servers',
    expected: 'Fonts are served from the site itself, so a visitor’s IP address is not sent to Google without consent.',
    observed: 'The project requests fonts from fonts.googleapis.com or fonts.gstatic.com. Courts in Germany have treated this as an unlawful transfer of the visitor’s IP address (LG München I, 3 O 17493/20).',
    fix: 'Download the font files into the project, serve them with @font-face from the same origin, and remove the Google Fonts links.' },
  { id: 'trackers', files: CODE, test: /google-analytics\.com|googletagmanager\.com|\bgtag\s*\(|connect\.facebook\.net|\bfbq\s*\(|static\.hotjar\.com|clarity\.ms|analytics\.tiktok\.com|snap\.licdn\.com|plausible\.io\/js|matomo\.js|cdn\.segment\.com|mixpanel\.com\/lib|posthog\.com/i, severity: 'high',
    title: 'Tracking or analytics script is loaded',
    expected: 'No tracker runs before the visitor has given informed consent (§ 25 TDDDG, Art. 6(1)(a) GDPR), or a consent-free, self-hosted measurement is used.',
    observed: 'The project loads an analytics or advertising script. Unless it only starts after an opt-in, reading or writing identifiers on the device needs prior consent.',
    fix: 'Load the script only after a consent decision (or replace it with self-hosted, cookie-free statistics), and make sure declining really prevents the request.', gated: /consent|einwillig|cookiebot|usercentrics|klaro|borlabs/i },
  { id: 'cdn', files: MARKUP, test: /(?:src|href)\s*=\s*["'](?:https?:)?\/\/(?:cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|ajax\.googleapis\.com|code\.jquery\.com|stackpath\.bootstrapcdn\.com|maxcdn\.bootstrapcdn\.com|kit\.fontawesome\.com|use\.typekit\.net)/i, severity: 'medium',
    title: 'Scripts or styles are loaded from a public CDN',
    expected: 'Libraries are bundled with the site, so visitors’ IP addresses go only to the site’s own host.',
    observed: 'A page pulls a library from a third-party CDN, which receives every visitor’s IP address and user agent.',
    fix: 'Add the library as a dependency or copy it into the project, and reference the local file.' },
  { id: 'embeds', files: MARKUP, test: /youtube\.com\/embed|player\.vimeo\.com|google\.com\/maps\/embed|maps\.googleapis\.com|platform\.twitter\.com|instagram\.com\/embed|open\.spotify\.com\/embed/i, severity: 'medium',
    title: 'Third-party embed loads without a click',
    expected: 'Videos and maps load only after the visitor clicks (a two-click solution) or have a privacy-friendly mode, and the privacy notice names the provider.',
    observed: 'An iframe or script from a video, map or social provider is present in the page, which contacts that provider as soon as the page opens.',
    fix: 'Show a static placeholder with a short notice, and load the embed (youtube-nocookie.com for YouTube) only after the visitor clicks.' },
  { id: 'insecure', files: PAGE, test: /(?:src|href|action)\s*=\s*["']http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i, severity: 'medium',
    title: 'Resource or form uses unencrypted http://',
    expected: 'Everything, forms above all, is sent over https (Art. 32 GDPR: appropriate security of processing).',
    observed: 'A page references an http:// address, so data can be read or changed in transit.',
    fix: 'Switch the address to https:// (or a relative path) and confirm the target supports it.' },
  { id: 'logs', files: CODE, test: /(?:console\.\w+|logger?\.\w+|log\.\w+|\bprint|\blogging\.\w+)\s*\(.*\b(?:password|passwort|iban|e-?mail|phone|telefon|ip_?address|req\.ip|remoteAddress|x-forwarded-for)\b/i, severity: 'medium', status: 'suspected',
    title: 'Personal data may be written to logs',
    expected: 'Logs hold no passwords and only the personal data they need, for a short, defined time (Art. 5(1)(c) and (e) GDPR).',
    observed: 'A log statement includes a field that normally holds personal data such as an e-mail address, phone number, IP address or password.',
    fix: 'Remove the personal field from the message or replace it with an opaque id, and never log credentials.' },
];

const record = (map, rule, file, index, line) => { const entry = map.get(rule.id) || { rule, hits: [], files: new Set() }; entry.files.add(file); if (entry.hits.length < 6) entry.hits.push({ file, line: index + 1, detail: line.trim().slice(0, 140) }); map.set(rule.id, entry); };
const item = (props, extra) => ({ source: 'compliance', status: 'observed', kind: 'compliance', area: 'backend', suggestion: true, aspects: ['compliance'], agreement: 1, confidence: 8, ...props, ...extra });

/** Indicators found by plain text rules. `redacted` is the result of redactPersonalData on the same contents. */
function scanCompliance(contents, redacted = null) {
  const hits = new Map();
  const consentFiles = new Set();
  for (const [file, body] of contents) {
    if (TEST_PATH.test(file)) continue;
    const lines = body.split('\n');
    for (const rule of RULES) {
      if (!rule.files.test(file)) continue;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].length > 4000 || !rule.test.test(lines[i])) continue;
        record(hits, rule, file, i, lines[i]);
        if (rule.gated?.test(body)) consentFiles.add(`${rule.id}:${file}`);
      }
    }
  }
  const findings = [];
  for (const { rule, hits: evidence, files } of hits.values()) {
    const everywhereGated = rule.gated && [...files].every(file => consentFiles.has(`${rule.id}:${file}`));
    findings.push(item({ title: rule.title, severity: everywhereGated ? 'medium' : rule.severity, status: rule.status || (everywhereGated ? 'suspected' : 'observed'), evidence,
      expected: rule.expected, observed: `${rule.observed} Found in ${files.size} file${files.size === 1 ? '' : 's'}.${everywhereGated ? ' The file mentions consent handling, so check that this only loads after opt-in.' : ''}`,
      fixPrompt: `${rule.title}. ${rule.observed} Locations:\n${evidence.map(e => `${e.file}:${e.line} ${e.detail}`).join('\n')}\n\n${rule.fix} ${HANDOFF}` }));
  }

  const sources = [...contents].filter(([file]) => !TEST_PATH.test(file));
  const pages = sources.filter(([file, body]) => PAGE.test(file) && /<(?:a|footer|nav|form|body)\b/i.test(body));
  if (pages.length) {
    const all = sources.map(([, body]) => body).join('\n');
    const where = [{ file: pages[0][0], line: 1, detail: `${pages.length} page file${pages.length === 1 ? '' : 's'} checked` }];
    if (!/impressum|imprint|legal[- ]notice|anbieterkennung/i.test(all)) findings.push(item({ title: 'No legal notice (Impressum) found', severity: 'medium', status: 'suspected', evidence: where,
      expected: 'A commercial site aimed at Germany links an easily reachable legal notice from every page (§ 5 DDG).',
      observed: 'No page, link or file mentions an Impressum, imprint or legal notice. Ignore this if the project is not a public business website.',
      fixPrompt: `Add a visible link to a legal notice page (Impressum) in the shared footer or layout, with an empty page that lists the required fields as TODO placeholders. ${HANDOFF}` }));
    if (!/datenschutz|privacy|data[- ]protection/i.test(all)) findings.push(item({ title: 'No privacy notice (Datenschutzerklärung) found', severity: 'high', status: 'suspected', evidence: where,
      expected: 'Visitors can reach a privacy notice from every page that collects or processes personal data (Art. 12 and 13 GDPR).',
      observed: 'No page, link or file mentions a privacy policy or Datenschutzerklärung. Ignore this if the project never handles personal data.',
      fixPrompt: `Add a visible link to a privacy notice page in the shared footer or layout, with a page that lists the required sections as TODO placeholders. ${HANDOFF}` }));
  }
  const forms = sources.filter(([file, body]) => PAGE.test(file) && /<form\b/i.test(body) && /type\s*=\s*["'](?:email|tel)["']|name\s*=\s*["'](?:e-?mail|phone|telefon|vorname|nachname|name)["']/i.test(body) && !/datenschutz|privacy|einwillig|consent|dsgvo|gdpr/i.test(body));
  if (forms.length) findings.push(item({ title: 'Form collects personal data without a privacy notice', severity: 'medium', status: 'suspected',
    evidence: forms.slice(0, 6).map(([file, body]) => ({ file, line: Math.max(1, body.slice(0, body.search(/<form\b/i)).split('\n').length), detail: 'A form asks for e-mail, phone or name; no privacy wording in this file' })),
    expected: 'Where personal data is collected, the person is told who processes it, why, and where to read more (Art. 13 GDPR), usually by a short note and a link next to the submit button.',
    observed: `${forms.length} form${forms.length === 1 ? '' : 's'} ask for contact details and the file has no privacy wording. A shared component could supply it, so check before changing anything.`,
    fixPrompt: `Next to the submit button of each form listed, add a short note that links to the privacy page, using a placeholder for the exact wording. ${HANDOFF}` }));

  if (redacted?.total) {
    const kinds = Object.entries(redacted.counts).filter(([, n]) => n).map(([kind, n]) => `${n} ${kind}${n === 1 ? '' : 's'}`).join(', ');
    findings.push(item({ title: 'Real-looking personal data is stored in the source', severity: 'low', status: 'suspected', confidence: 7,
      evidence: redacted.found.slice(0, 6).map(entry => ({ file: entry.file, line: entry.line, detail: `${entry.kind} address or number (value not shown)` })),
      expected: 'Source code and fixtures hold no real people’s contact or bank details (Art. 5(1)(c) GDPR), and anything that must stay is covered by a legal basis.',
      observed: `Found ${kinds}. They were replaced with placeholders before the text went to the cloud models, so the models never saw them. Check that they belong in the repository at all.`,
      fixPrompt: `Replace the real-looking contact or bank details at the listed locations with obviously fake test values (for example name@example.com). ${HANDOFF}` }));
  }
  const rank = { high: 0, medium: 1, low: 2 };
  return findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

const redactText = text => redactPersonalData(new Map([['text.txt', String(text)]])).contents.get('text.txt');

module.exports = { redactPersonalData, redactText, scanCompliance, validIban };
