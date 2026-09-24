'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyTask, synthesizeBatch, sliceIntoAffinityBatches, reasoningTier } from '../lib/batch-synthesizer.mjs';

test('classifies individual tasks by semantic domain', () => {
  assert.equal(classifyTask({ prompt: 'Change navbar glass blur to 28px' }), 'ui_aesthetics');
  assert.equal(classifyTask({ prompt: 'Fix Zod schema loader and run tests', file: 'scripts/edit/scan.mjs' }), 'backend_ast');
  assert.equal(classifyTask({ prompt: 'Review entire roadmap and summarize missing docs', file: 'docs/todo.md' }), 'planning_synthesis');
});

test('word-boundary keywords do not false-positive inside unrelated words', () => {
  // "notes" must not match inside "denotes"/"connotes" -- a plain
  // .includes('notes') check used to misroute these into planning_synthesis.
  assert.equal(classifyTask({ prompt: 'this button denotes the primary action, add a border to it' }), 'ui_aesthetics');
  assert.equal(classifyTask({ prompt: 'the color connotes a warning state' }), 'ui_aesthetics');
  // A genuine "notes" task (not embedded in another word) still classifies as planning.
  assert.equal(classifyTask({ prompt: 'check the handoff notes for uncompleted items' }), 'planning_synthesis');
  // "review" must not match inside "preview".
  assert.equal(classifyTask({ prompt: 'fix the preview modal spacing' }), 'ui_aesthetics');
});

test('a prompt naming both a planning word and a concrete UI keyword prefers UI', () => {
  // Bucket-ordering regression: "audit"/"review" language describing a
  // concrete CSS/UI task must not get short-circuited into planning_synthesis.
  assert.equal(classifyTask({ prompt: 'audit the css spacing on the hero' }), 'ui_aesthetics');
  assert.equal(classifyTask({ prompt: 'review the button hover animation' }), 'ui_aesthetics');
  // With no competing UI signal, the planning word still wins.
  assert.equal(classifyTask({ prompt: 'audit the roadmap for missing phases' }), 'planning_synthesis');
});

test('synthesizes a 20-task batch into 3 distinct model packages', () => {
  const sampleTasks = [
    // 6 UI tasks (Claude)
    { prompt: 'Make navbar background frosted glass with blur', file: 'site/src/layouts/Screen.astro' },
    { prompt: 'Update hero button spring physics on hover', file: 'site/src/layouts/Screen.astro' },
    { prompt: 'Adjust card border opacity to 0.08', file: 'site/src/pages/index.astro' },
    { prompt: 'Fix typography line height on mobile layout', file: 'site/src/layouts/Screen.astro' },
    { prompt: 'Add subtle shadow to preview modal', file: 'site/src/components/Modal.astro' },
    { prompt: 'Refactor footer logo styling', file: 'site/src/layouts/Screen.astro' },

    // 7 Backend / AST tasks (Codex)
    { prompt: 'Update AST parser to handle optional frontmatter keys', file: 'site/scripts/edit/lib/ts-source.mjs' },
    { prompt: 'Add Zod validator for content config', file: 'site/src/content.config.ts' },
    { prompt: 'Write unit tests for mdast splicing logic', file: 'site/scripts/edit/lib/markdown-body.mjs' },
    { prompt: 'Fix PowerShell script escaping on Windows', file: 'tools/voice-router/daemon.ps1' },
    { prompt: 'Verify atomic rollback on failed file edit', file: 'site/scripts/edit/apply.mjs' },
    { prompt: 'Clean npm build artifacts', file: 'site/package.json' },
    { prompt: 'Benchmark schema loader latency', file: 'site/scripts/edit/verify-schema-loader.mjs' },

    // 7 Planning & Doc tasks (Gemini)
    { prompt: 'Review entire 7-phase roadmap against shipped packages', file: 'docs/content-editor-todo.md' },
    { prompt: 'Summarize architectural differences between Phase 5 and Phase 6', file: 'README.md' },
    { prompt: 'Audit all documentation files for broken links', file: 'docs/content-editor-spec.md' },
    { prompt: 'Compare token consumption between single-agent and multi-agent workflows', file: 'docs/voice-quota-router-spec.md' },
    { prompt: 'Draft executive summary for the living styleguide rollout', file: 'docs/editor-ui-critique.md' },
    { prompt: 'Check handoff notes for uncompleted items', file: 'docs/handoff.md' },
    { prompt: 'Generate release notes outline for version 1.5', file: 'docs/content-editor-v1.5-handoff.md' },
  ];

  assert.equal(sampleTasks.length, 20);

  // The real shape readQuotas() returns -- claude5hRemainingPct, not
  // claude5h. Mocking the wrong key here is exactly what let the quota
  // field-name bug ship with green tests.
  const result = synthesizeBatch(sampleTasks, { quotas: { claude5hRemainingPct: 85 } });

  assert.equal(result.totalTasks, 20);
  assert.equal(result.breakdown.uiTasks, 6);
  assert.equal(result.breakdown.backendTasks, 7);
  assert.equal(result.breakdown.planningTasks, 7);

  // Each key is an array of phases (P12-B); all three buckets here sit
  // under the single-phase cap, so each comes back as exactly one phase.
  assert.equal(result.packages.claude.length, 1);
  assert.equal(result.packages.claude[0].taskCount, 6);
  assert.equal(result.packages.claude[0].targetModel, 'claude');
  assert.match(result.packages.claude[0].formattedPrompt, /### Master UI Refactoring Directive \(6 tasks bundled for Claude Sonnet\)/);
  assert.match(result.packages.claude[0].formattedPrompt, /Cohesive Goal/);

  // Verify Codex package
  assert.equal(result.packages.codex.length, 1);
  assert.equal(result.packages.codex[0].taskCount, 7);
  assert.equal(result.packages.codex[0].targetModel, 'codex');
  assert.match(result.packages.codex[0].formattedPrompt, /### Master Backend & Execution Directive \(7 tasks bundled for Codex\)/);

  // Verify Gemini package
  assert.equal(result.packages.gemini.length, 1);
  assert.equal(result.packages.gemini[0].taskCount, 7);
  assert.equal(result.packages.gemini[0].targetModel, 'gemini');
  assert.match(result.packages.gemini[0].formattedPrompt, /### Master Architecture & Documentation Directive \(7 tasks bundled for Gemini\)/);
});

test('reroutes UI tasks to Codex when Claude quota is below 20%', () => {
  const uiTasks = [
    { prompt: 'Make navbar glass blur 28px', file: 'site/src/layouts/Screen.astro' },
    { prompt: 'Refactor hero button physics', file: 'site/src/layouts/Screen.astro' },
  ];

  const result = synthesizeBatch(uiTasks, { quotas: { claude5hRemainingPct: 12 } });

  assert.equal(result.quotasUsed.isClaudeThrottled, true);
  assert.equal(result.packages.codex_failover.length, 1);
  assert.equal(result.packages.codex_failover[0].targetModel, 'codex');
  assert.equal(result.packages.codex_failover[0].quotaOverrideApplied, true);
  assert.match(result.packages.codex_failover[0].formattedPrompt, /LOW-QUOTA FAILOVER -> CODEX/);
});

test('a throttled Claude failover does not discard real Codex backend tasks in the same batch', () => {
  // Regression test for the merge-logic bug: both packages used to key off
  // targetModel ('codex' for both a failed-over UI package and a genuine
  // backend package), so the second one silently overwrote the first.
  const mixedTasks = [
    { prompt: 'Make navbar glass blur 28px', file: 'site/src/layouts/Screen.astro' },
    { prompt: 'Add Zod validator for content config', file: 'site/src/content.config.ts' },
    { prompt: 'Write unit tests for the schema loader', file: 'site/scripts/edit/verify-schema-loader.mjs' },
  ];

  const result = synthesizeBatch(mixedTasks, { quotas: { claude5hRemainingPct: 5 } });

  assert.equal(result.quotasUsed.isClaudeThrottled, true);

  // The failed-over UI directive is present...
  assert.ok(result.packages.codex_failover, 'failed-over UI package should exist');
  assert.equal(result.packages.codex_failover[0].taskCount, 1);

  // ...and the genuine backend package must NOT have been discarded.
  assert.ok(result.packages.codex, 'real backend package must survive alongside the failover package');
  assert.equal(result.packages.codex[0].taskCount, 2);
  assert.equal(result.packages.codex[0].quotaOverrideApplied, false);
});

test('P12-B: file locality keeps a same-file group intact except when the cap itself forces a split', () => {
  // 12 tasks all on one file: over the 10-task cap, so this single file
  // group must itself split into a full 10-task phase plus a 2-task
  // remainder -- the full phase from that split must stay pure (never
  // padded out with an unrelated file's tasks).
  const sameFileTasks = Array.from({ length: 12 }, (_, i) => ({
    prompt: `Tweak spacing rule #${i}`,
    file: 'site/src/styles/tokens.css',
  }));
  const otherFileTask = { prompt: 'Add a new card component', file: 'site/src/components/Card.astro' };
  const isTokensTask = (t) => t.file === 'site/src/styles/tokens.css';

  const phases = sliceIntoAffinityBatches([...sameFileTasks, otherFileTask]);
  const tokensPhases = phases.filter((p) => p.tasks.some(isTokensTask));
  assert.equal(tokensPhases.length, 2, 'a 12-task single-file group over the 10-cap must split into exactly 2 phases');
  assert.equal(tokensPhases.reduce((sum, p) => sum + p.tasks.filter(isTokensTask).length, 0), 12);

  const fullPhase = tokensPhases.find((p) => p.tasks.length === 10);
  assert.ok(fullPhase, 'one phase from the forced split should sit exactly at the cap');
  assert.ok(fullPhase.tasks.every(isTokensTask), 'the at-cap phase from a forced split must stay pure');
});

test('P12-B: dual-sourced project tasks (.astro transcript + .mdx prose) stay in the same phase', () => {
  const tasks = [
    { prompt: 'Reword the intro paragraph', file: 'site/src/pages/[...lang]/pneumatikventil.astro', pageSlug: 'pneumatikventil' },
    { prompt: 'Match the reworded intro in the MDX prose', file: 'site/src/content/projects/pneumatikventil.mdx', pageSlug: 'pneumatikventil' },
    { prompt: 'Unrelated fix on a different project', file: 'site/src/pages/[...lang]/wavetray.astro', pageSlug: 'wavetray' },
  ];
  const phases = sliceIntoAffinityBatches(tasks);
  const phase = phases.find((p) => p.tasks.some((t) => t.file.includes('pneumatikventil')));
  const pneumatikventilTasks = phase.tasks.filter((t) => t.file.includes('pneumatikventil'));
  assert.equal(pneumatikventilTasks.length, 2, 'the .astro and .mdx pair for the same slug must land in the same phase');
});

test('P12-B: phases are capped at 10 tasks and sequenced structural-first', () => {
  // 25 backend tasks across 25 distinct files -- no file/page affinity to
  // force grouping, so this purely exercises the cap and the structural
  // ordering (structural .astro/.ts/.mjs tasks before .css tasks).
  const structuralTasks = Array.from({ length: 15 }, (_, i) => ({ prompt: `Fix parser edge case ${i}`, file: `site/scripts/edit/lib/mod-${i}.mjs` }));
  const styleTasks = Array.from({ length: 10 }, (_, i) => ({ prompt: `Adjust spacing token ${i}`, file: `site/src/styles/mod-${i}.css` }));
  const phases = sliceIntoAffinityBatches([...styleTasks, ...structuralTasks]);

  assert.ok(phases.every((p) => p.tasks.length <= 10), 'no phase may exceed the 8-10 task cap');
  assert.equal(phases.reduce((sum, p) => sum + p.tasks.length, 0), 25);
  // Structural-first: the earliest phase should skew toward .mjs tasks
  // rather than the .css tasks queued first in the input array.
  assert.ok(phases[0].tasks.every((t) => t.file.endsWith('.mjs')), 'Phase 1 should be a pure structural phase, not styling');
});

test('P12-B: collision matrix flags only phases that share a file', () => {
  // 20 same-file tasks split into exactly two full 10-task phases (no
  // leftover capacity), so the unrelated scan.mjs task can't be packed
  // into either and is guaranteed its own, fully disjoint phase.
  const tasks = [
    ...Array.from({ length: 20 }, (_, i) => ({ prompt: `Task ${i}`, file: 'site/src/styles/tokens.css' })),
    { prompt: 'Fully unrelated task', file: 'site/scripts/edit/scan.mjs' },
  ];
  const phases = sliceIntoAffinityBatches(tasks);
  const tokensPhases = phases.filter((p) => p.files.includes('site/src/styles/tokens.css'));
  const scanPhase = phases.find((p) => p.files.includes('site/scripts/edit/scan.mjs'));

  assert.equal(tokensPhases.length, 2);
  assert.ok(tokensPhases.every((p) => p.tasks.length === 10 && p.files.length === 1), 'both tokens.css phases should be pure, at-cap splits');
  assert.ok(tokensPhases[0].collidesWith.includes(tokensPhases[1].phase), 'two phases splitting the same file must collide');
  assert.ok(tokensPhases[1].collidesWith.includes(tokensPhases[0].phase));
  assert.notEqual(scanPhase, tokensPhases[0]);
  assert.notEqual(scanPhase, tokensPhases[1]);
  assert.deepEqual(scanPhase.collidesWith, [], 'a phase touching a fully disjoint file must have no collisions');
});

test('P12-G: a dual-sourced project task gets an explicit "update both sides" directive', () => {
  const tasks = [
    { prompt: 'Reword the intro sentence', file: 'site/src/pages/[...lang]/pneumatikventil.astro', path: 'transcript.de[0]', pairedFile: 'src/content/projects/pneumatikventil.de.mdx' },
  ];
  const result = synthesizeBatch(tasks, { quotas: { claude5hRemainingPct: 85 } });
  const pkg = Object.values(result.packages)[0][0];
  assert.match(pkg.formattedPrompt, /Dual-Source Content Sync/);
  assert.match(pkg.formattedPrompt, /Project `pneumatikventil` uses paired copy/);
  assert.match(pkg.formattedPrompt, /src\/pages\/\[\.\.\.lang\]\/pneumatikventil\.astro/);
  assert.match(pkg.formattedPrompt, /src\/content\/projects\/pneumatikventil\.mdx/);
  assert.match(pkg.formattedPrompt, /npm run check-sync/);
});

test('P12-G: a phase mixing two paired projects lists both slugs exactly once each, deduped per project not per task', () => {
  const pairedTasks = [
    { prompt: 'Reword sentence A', file: 'site/src/pages/[...lang]/wavetray.astro', pairedFile: 'src/content/projects/wavetray.de.mdx' },
    { prompt: 'Reword sentence B (same project)', file: 'site/src/pages/[...lang]/wavetray.astro', pairedFile: 'src/content/projects/wavetray.en.mdx' },
    { prompt: 'Reword sentence C (different project)', file: 'site/src/pages/[...lang]/bmw-tisch.astro', pairedFile: 'src/content/projects/bmw-tisch.de.mdx' },
  ];
  const result = synthesizeBatch(pairedTasks, { quotas: { claude5hRemainingPct: 85 } });
  const pkg = Object.values(result.packages)[0][0];
  const wavetrayMentions = pkg.formattedPrompt.match(/Project `wavetray` uses paired copy/g) || [];
  const bmwMentions = pkg.formattedPrompt.match(/Project `bmw-tisch` uses paired copy/g) || [];
  assert.equal(wavetrayMentions.length, 1, 'wavetray should be named once even though 2 of its tasks are paired');
  assert.equal(bmwMentions.length, 1);
});

test('P12-G: a task with no pairedFile adds no dual-sync directive', () => {
  const noPairTask = { prompt: 'Fix a typo', file: 'site/src/components/Card.astro' };
  const result = synthesizeBatch([noPairTask], { quotas: { claude5hRemainingPct: 85 } });
  const pkg = Object.values(result.packages)[0][0];
  assert.doesNotMatch(pkg.formattedPrompt, /Dual-Source Content Sync/);
});

test('an empty task list returns a consistent shape instead of a partial object', () => {
  // Regression test: router.mjs's --batch CLI unconditionally reads
  // result.breakdown.uiTasks and result.quotasUsed.claude5hRemainingPct --
  // the early-return path must supply both, not just totalTasks/packages.
  const result = synthesizeBatch([]);

  assert.equal(result.totalTasks, 0);
  assert.deepEqual(result.breakdown, { uiTasks: 0, backendTasks: 0, planningTasks: 0 });
  assert.equal(typeof result.quotasUsed.claude5hRemainingPct, 'number');
  assert.equal(result.quotasUsed.isClaudeThrottled, false);
  assert.deepEqual(result.packages, {});
});

test('P17-C: deep structural work is flagged for Opus 5.5 with a cost projection; styling and copy stay fast', () => {
  assert.equal(reasoningTier([{ prompt: 'Migrate the YAML schema loader to typed AST nodes' }], ['src/lib/schema-loader.mjs']), 'opus');
  assert.equal(reasoningTier([{ prompt: 'Refactor the batch queue' }], ['a.mjs', 'b.mjs']), 'opus', 'a refactor spanning files');
  assert.equal(reasoningTier([{ prompt: 'Refactor this helper' }], ['a.mjs']), 'fast', 'a one-file refactor stays fast');
  assert.equal(reasoningTier([{ prompt: 'Make the hero button padding 12px' }], ['src/styles/tokens.css']), 'fast');
  assert.equal(reasoningTier([{ prompt: 'Sync the German translation of this caption' }]), 'fast');

  const quotas = { claude5hRemainingPct: 80 };
  const result = synthesizeBatch([
    { index: 1, prompt: 'Extend the AST parser for MDX frontmatter', file: 'src/lib/markdown-body.mjs' },
    { index: 2, prompt: 'Soften the card shadow', file: 'src/styles/card.css' },
  ], { quotas });
  const backend = result.packages.codex[0];
  assert.equal(backend.reasoningTier, 'opus');
  assert.equal(backend.escalation.suggested, true);
  assert.equal(backend.escalation.target, 'opus');
  assert.deepEqual(backend.escalation.pricePerMTok, { input: 4, output: 20 });
  assert.equal(backend.escalation.costMultiplier, 2);
  assert.equal(backend.escalation.promptTokens, Math.ceil(backend.formattedPrompt.length / 4));
  assert.equal(backend.targetModel, 'codex', 'escalation is a suggestion; the package target is unchanged');
  assert.equal(result.packages.claude[0].escalation.suggested, false, 'styling is not escalated, but can be by hand');
});
