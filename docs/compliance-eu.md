# EU and GDPR compliance

Technical guidance for building in the EU and Germany with Clanker Controller. It is not legal advice. You are responsible for
what you publish; a lawyer or your data protection officer has the last word. Settings > **Compliance** holds the switches, the
data-flow list and the pre-ship checklist described here.

## What leaves your computer

Every agent you chat with sends its input to its provider: Claude Code to Anthropic, Codex to OpenAI, Antigravity to Google.
That input is your messages, attachments and the project files the agent reads or edits. Smart routing sends message text to
Cloudflare and Groq (secrets redacted, private projects never), Groq also receives dictation audio, Telegram receives the alerts
you configure. Project files, chat history, routing logs and a loop's private copy stay local. The Compliance tab lists each flow
and links the provider's own terms; certifications and agreements change, so the tab states none and you check the current ones.

The point that matters most: a processing agreement (Art. 28 GDPR) is normally offered for business, team and API accounts, not for
personal chat subscriptions. Before an agent reads real customer, patient or employee data, check which plan each CLI uses.

## Loops

Two switches, both on by default (`aiChatPanel.complianceScout`, `aiChatPanel.complianceRedact`).

**Hide personal data from cloud models.** Scouts, verifiers, judges and the recent-changes diff are cloud calls. Before they are
built, real-looking e-mail addresses, IBANs (checksum-validated, so ordinary ids are not mistaken) and phone numbers are replaced
by `[email]`, `[iban]` and `[phone]` inside their line, so cited line numbers stay valid. Examples (`example.com`, `localhost`,
`img@2x.png`, the documentation IBAN) are left alone. Your files and the private copy the editors work in keep the real values;
`lib/loop-compliance.js` `redactPersonalData`. Editors are the agents you chose and see the private copy.

**EU compliance check.** One more scout (`compliance`, the eleventh) reads the project for indicators of GDPR, TDDDG, AI Act,
accessibility (BFSG) and Cyber Resilience Act problems. In the same step, free text rules (no tokens) look for remote Google
Fonts, trackers and analytics, public CDNs, video and map embeds, `http://` resources, personal data in log statements, a site
without an imprint or privacy page, forms that collect contact details without a privacy note, and real personal data stored in
source. Tests and docs are skipped.

These are indicators for you to judge. They are reported as "An indicator for you to judge, not a legal verdict", the scout is told
to use *suspected* unless the code plainly shows the problem and never to write privacy text or consent wording, and they are
**never fixed automatically**: the editors only work on confirmed bugs. A fix prompt is included so you can hand a finding to an
agent yourself; it tells the agent to leave legal text as a marked TODO.

## Limits

The checks read code, not your live site, your contracts or your processes. They cannot tell whether a consent banner really blocks
a request, whether a provider agreement is in place, or whether a legal basis exists. A clean result is not a clearance.

## Tests

`node --test ai-chat-panel/test/loop-compliance.test.js` (redaction and rules), `ai-chat-panel/test/loop-engine.test.js` (no
prompt carries the address, indicators are listed and never edited, both switches off), and `npm.cmd run test:compliance-ui`
(the tab, its switches and links, no overflow at 364 px; pictures go to the temp folder).
