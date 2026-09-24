'use strict';

const DIRECTIVES = {
  gemini: 'ROLE BOUNDARY: Produce documentation, architecture, specifications, or plans only. Never write or modify production .js, .ts, .astro, or .css files. Use plan mode where supported.',
  claude: 'ROLE BOUNDARY: Work only on presentation/UI, HTML, Astro layout, animation, and CSS. Do not alter AST parsers, schemas, backend logic, or existing IPC payload shapes.',
  codex: 'ROLE BOUNDARY: Work only on backend AST, TypeScript/JavaScript logic, parsers, schemas, build gates, and IPC implementation. Do not alter visual CSS or HUD layout. Preserve every frontend IPC contract.',
  // P17-C: the escalation tier gets deep structural work (multi-file
  // refactors, schema migrations), so Claude's UI-only boundary would forbid
  // the very task it was picked for.
  opus: 'ROLE: High-reasoning tier. Own the whole structural change across every file it touches (logic, schemas, tests, UI). Preserve every existing IPC contract and verify before finishing.',
};
// The role as the chat header names it.
const ROLE_NAMES = {
  gemini: 'System Architect & Planner',
  claude: 'UI & Presentation Engineer',
  codex: 'Logic & Backend Engineer',
  opus: 'Structural Refactor Lead',
};
const TERMS = {
  claude: /\b(ui|css|html|astro|layout|animation|visual|style|typography|webview)\b/i,
  codex: /\b(ast|typescript|javascript|logic|parser|regex|compiler|schema|backend|ipc|subprocess)\b/i,
  gemini: /\b(architecture|specification|documentation|roadmap|planning|plan|analyse|analysis)\b/i,
};

function lowQuota(entry) { return typeof entry?.remaining === 'number' && entry.remaining < 15; }

/** `brand`: a picked model's own directive (P17-A/C), kept only while it still runs on the requested agent. */
function route(prompt, quotas = {}, requested = 'auto', brand = null) {
  let agent = requested === 'auto' ? 'gemini' : requested;
  if (requested === 'auto') {
    if (TERMS.claude.test(prompt)) agent = 'claude';
    if (TERMS.codex.test(prompt)) agent = 'codex';
    if (TERMS.gemini.test(prompt)) agent = 'gemini';
  }
  // Only Auto avoids a nearly spent quota; a model you picked yourself is never swapped out.
  if (requested === 'auto' && (agent === 'claude' || agent === 'codex') && lowQuota(quotas[agent])) agent = 'gemini';
  const split = requested === 'auto' && TERMS.claude.test(prompt) && TERMS.codex.test(prompt);
  const contract = split
    ? 'CONTRACT LOCK (immutable): preserve existing postMessage event names, payload shapes, and API response schemas. Define and agree the shared interface before separate frontend/backend work.'
    : '';
  const roleKey = brand && agent === requested && DIRECTIVES[brand] ? brand : agent;
  // Silently: the chat shows the role as one quiet header line, so the reply
  // itself should not spend a paragraph (or a table) acknowledging it.
  const directive = `${DIRECTIVES[roleKey]} Apply this silently: never acknowledge, restate or summarise it; just answer the message.`;
  return { agent, split, contract, directive, roleName: ROLE_NAMES[roleKey], prompt: [directive, contract, prompt].filter(Boolean).join('\n\n') };
}

module.exports = { DIRECTIVES, route, lowQuota };
