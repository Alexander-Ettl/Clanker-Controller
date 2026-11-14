'use strict';

// A CLI can be installed and signed in and still be unusable: the subscription ended, credits ran out, or the sign-in was
// rejected. `login status` does not notice, so Clanker learns it the way you would: from the failed turn. This reads the
// last line of a reply (where the engines append "<CLI> error: ...") and says what kind of failure it is, for any provider.
// A usage limit that resets is not one of them: that keeps its own flow (scheduled continue) and its gauge at 0%.

const { LIMIT_RE } = require('../media/limit-notice.js');

const KINDS = [
  ['blocked', /\b403\b.*(?:Cloudflare|Attention Required)|Cloudflare.*\b403\b/i,
    'Request blocked by Cloudflare (HTTP 403).'],
  ['plan', /not supported when using [^\n]{0,40}(account|plan|subscription)|\b(subscription|plan|trial|membership)\b[^\n]{0,60}\b(expired|ended|lapsed|cancell?ed|inactive|required|(?:does(?: not|n['’]t)|do not) include)|requires? (?:a |an )?(?:paid|active|pro|plus|premium)\b|\b(?:upgrade|subscribe)\b[^\n]{0,40}\b(?:plan|subscription|pro|plus)\b|not included in your (?:plan|subscription)|organization has been disabled|does not have access to claude|account ineligible/i,
    'Your plan or subscription no longer covers it.'],
  ['credits', /credit balance is too low|insufficient (?:credits|funds)|out of credits|billing (?:hard )?limit|payment required|billing (?:is )?(?:inactive|not active)/i,
    'Out of credits, or billing is inactive.'],
  ['auth', /failed to authenticate|not (?:logged|signed) in|please (?:log|sign) in|\b(?:log|sign) in again|invalid (?:api key|token|credentials)|authentication (?:failed|required|error)|token (?:has )?expired|session (?:has )?expired|unauthorized|eligibility check failed/i,
    'The sign-in was rejected or has expired. Sign in again in the CLI, then try again.'],
];

/** @returns {{ kind: 'plan' | 'credits' | 'auth' | 'blocked', reason: string, detail: string } | null} */
function accessFailure(raw) {
  const lines = String(raw || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const last = lines.at(-1) || '';
  // Only what an engine reports as its own error: a model discussing "unauthorized" in its answer is not one.
  if (!last || last.length > 600 || !/^(?:unable to start [\w.-]+:|[\w.-]+(?: [\w.-]+){0,2} error:|upstream unavailable|Failed to authenticate\.\s*API Error:)/i.test(last)) return null;
  if (LIMIT_RE.test(last)) return null;
  const hit = KINDS.find(([, pattern]) => pattern.test(last));
  if (!hit) return null;
  const detail = last.replace(/^[\w.-]+(?: [\w.-]+){0,2} error:\s*/i, '').replace(/^\{.*?"message":\s*"(.*?)"\}*\s*$/s, '$1').slice(0, 240);
  return { kind: hit[0], reason: hit[2], detail };
}

module.exports = { accessFailure };
