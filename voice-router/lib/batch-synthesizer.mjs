'use strict';

/**
 * Batch Task Staging & Multi-Agent Synthesizer (docs/batch-synthesis-workflow.md)
 *
 * Takes N staged tasks (from the Content Editor's walkthrough or Voice Router),
 * groups them into model-specific packages (Claude, Codex, Gemini) using quota-aware
 * semantic rules, and synthesizes each package into a single master architectural
 * directive with a unified game plan.
 */

import { readQuotas, LOW_QUOTA_THRESHOLD } from './quota-reader.mjs';

// Short, common-English-word keywords get a word-boundary check instead of
// plain substring matching -- ".includes('notes')" also matches inside
// "denotes"/"connotes", which are plausible words in an ordinary UI-review
// prompt. Longer/technical keywords (css, glass, typography, ...) don't
// collide with real words this way, and forcing all of them through \b\b
// would break matches inside camelCase identifiers a prompt might mention
// literally (e.g. "buttonHover", "backgroundColor"), so they stay plain
// substring checks.
const WORD_BOUNDARY_KEYWORDS = new Set(['notes']);

const PLANNING_KEYWORDS = [
  'roadmap', 'document', 'summarize', 'compare', 'architect',
  'brief', 'strategy', 'notes', 'audit', 'outline',
];

const UI_KEYWORDS = [
  'css', 'style', 'color', 'glass', 'blur', 'spring', 'font', 'typography',
  'padding', 'margin', 'border', 'opacity', 'shadow', 'modal', 'layout',
  'button', 'animation', 'hover', 'logo',
];

function matchesKeyword(text, keyword) {
  if (WORD_BOUNDARY_KEYWORDS.has(keyword)) {
    return new RegExp(`\\b${keyword}\\b`, 'i').test(text);
  }
  return text.includes(keyword);
}

/**
 * Classifies a task based on keyword signatures and AST metadata.
 */
export function classifyTask(task) {
  const prompt = (task.prompt || task.rawPrompt || '').toLowerCase();
  const file = (task.file || task.activeFile || '').toLowerCase();
  const kind = (task.kind || '').toLowerCase();

  const isPlanningFile = file.endsWith('.md') || file.endsWith('.txt') || file.includes('docs/');
  const reviewHit = /\breview\b/i.test(prompt) && !prompt.includes('code review');
  const planningHit = reviewHit || PLANNING_KEYWORDS.some((keyword) => matchesKeyword(prompt, keyword));
  const uiHit = kind.includes('image') || file.endsWith('.css') || UI_KEYWORDS.some((keyword) => prompt.includes(keyword));

  // A prompt matching both a planning-ish word ("audit", "review") and a
  // concrete UI keyword ("css") -- e.g. "audit the css spacing on the hero"
  // -- is almost always a UI task described with review language, not an
  // abstract planning task. Prefer the more specific signal instead of
  // letting bucket-check order decide it.
  if (isPlanningFile || (planningHit && !uiHit)) return 'planning_synthesis';
  if (uiHit) return 'ui_aesthetics';
  return 'backend_ast';
}

// P17-C: high-reasoning escalation. Deep structural work (AST/schema
// migrations, compiler and parser extensions, test harness engineering,
// refactors spanning several files) is flagged for Claude Opus 5.5; styling,
// copy, translation sync and asset swaps stay on the fast tier. It is only a
// suggestion: the pre-flight sheet shows it as a toggle, so nothing runs on
// the ~2x tier unseen. Prices and the multiplier are the Phase 17 benchmark
// table's in docs/content-editor-todo.md, not live API pricing.
const DEEP_REASONING = /\b(ast|schemas?|migrat\w*|compilers?|parsers?|codemods?|test harness)\b/i;
const REFACTOR = /\brefactor\w*/i;
export const OPUS_ESCALATION = { target: 'opus', label: 'Claude Opus 5.5', pricePerMTok: { input: 4, output: 20 }, costMultiplier: 2 };

export function reasoningTier(tasks, files = []) {
  const prompts = tasks.map((t) => t.prompt || t.rawPrompt || '');
  const deep = prompts.some((p) => DEEP_REASONING.test(p)) || (files.length > 1 && prompts.some((p) => REFACTOR.test(p)));
  return deep ? 'opus' : 'fast';
}

// P12-B: frontier-model sweet spot a single phase should be capped at (see
// docs/content-editor-todo.md's own "6-10 tasks" framing) -- kept a little
// below the 12-task ceiling that content-editor-todo.md names as "exceeds
// single-phase limits" so a bucket sitting right at that ceiling still gets
// one comfortable phase instead of splitting on a hair's difference.
const BATCH_CAP = 10;

// P12-G: `pairedFile` (site/src/editor-plugins/portfolio.mjs's scanner
// sets this on every transcript/steps entry) points at
// `src/content/projects/<slug>.<lang>.mdx` -- the slug is the one piece
// of that path worth surfacing in the directive itself, so it's pulled
// back out here rather than adding a second, separate "slug" field to
// every task just to say the same thing twice.
const PAIRED_FILE_SLUG_PATTERN = /^src\/content\/projects\/([^./]+)\./;

function pairedProjectSlug(task) {
  const match = PAIRED_FILE_SLUG_PATTERN.exec(task.pairedFile || '');
  return match ? match[1] : null;
}

/**
 * Dual-Source Content Sync directive (P12-G): when a phase includes tasks
 * for a project whose reading copy is dual-sourced (the .astro transcript
 * AND a same-slug .mdx body, see check-content-sync.mjs), the synthesized
 * directive says so explicitly instead of leaving an agent to edit only
 * whichever file the pointer happened to name.
 */
function dualSyncDirectiveLines(phaseTasks) {
  const slugs = [...new Set(phaseTasks.map(pairedProjectSlug).filter(Boolean))].sort();
  if (slugs.length === 0) return [];
  const notes = slugs.map(
    (slug) =>
      `- Project \`${slug}\` uses paired copy. Update the \`transcript\` array in \`src/pages/[...lang]/${slug}.astro\` AND the prose in \`src/content/projects/${slug}.mdx\`, ensuring zero drift. Run \`npm run check-sync\` before considering this done.`,
  );
  return ['**Dual-Source Content Sync:**', ...notes, ''];
}

/**
 * Best-effort page/component boundary for a task, used to keep tasks that
 * belong to the same page (or the same dual-sourced project, see P12-G)
 * adjacent in the same phase even when they touch two different files
 * (e.g. a project's `.astro` transcript and its `.mdx` prose).
 */
function affinitySlug(task) {
  if (task.pageSlug) return task.pageSlug;
  const file = task.file || task.activeFile || '';
  const pageMatch = /pages\/\[\.\.\.lang\]\/([^./]+)\.astro$/.exec(file);
  if (pageMatch) return pageMatch[1];
  const contentMatch = /content\/projects\/([^./]+)\.mdx?$/.exec(file);
  if (contentMatch) return contentMatch[1];
  if (!file) return 'unmapped';
  const dir = file.split('/').slice(0, -1).join('/');
  return dir || file;
}

/**
 * Sequencing weight for "structural AST/schema changes first, then visual
 * styling, then prose" -- lower runs earlier. Used both to order tasks
 * inside one phase and to decide which phase (of several for the same
 * model) should be numbered Phase 1.
 */
function structuralWeight(task) {
  if (task.structural) return 0;
  const file = (task.file || task.activeFile || '').toLowerCase();
  const kind = (task.kind || '').toLowerCase();
  if (file.endsWith('.astro') || file.endsWith('.ts') || file.endsWith('.mjs') || file.endsWith('.ast')) return 0;
  if (file.endsWith('.css') || kind.includes('image') || kind.includes('style')) return 1;
  return 2;
}

/**
 * Deterministic Affinity Slicer & Collision Matrix (P12-B).
 *
 * Groups same-domain tasks into phases (batches) without ever separating
 * tasks that touch the same file, caps each phase at BATCH_CAP, orders
 * phases structural-first, and tags each phase with which other phases it
 * collides with (shares a file with) -- collision-free phases are safe to
 * dispatch in parallel; colliding ones must run serially in file order.
 *
 * Deliberately no ML/embedding step (see 12.1 "Zero Heavy ML Bloat"): file
 * path and page-slug identity are exact, deterministic keys.
 */
export function sliceIntoAffinityBatches(tasks, { cap = BATCH_CAP } = {}) {
  if (!Array.isArray(tasks) || tasks.length === 0) return [];

  // 1. File Locality First: tasks touching the same source file are
  //    strictly locked into the same group before anything else groups.
  const fileGroups = new Map();
  for (const task of tasks) {
    const key = task.file || task.activeFile || `__unmapped_${affinitySlug(task)}_${fileGroups.size}`;
    if (!fileGroups.has(key)) fileGroups.set(key, []);
    fileGroups.get(key).push(task);
  }

  // 2. Component/Page Affinity: merge file-groups sharing a page slug or
  //    component boundary, so e.g. a dual-sourced project's .astro + .mdx
  //    pair stay in the same phase.
  const pageGroups = new Map();
  for (const groupTasks of fileGroups.values()) {
    const slug = affinitySlug(groupTasks[0]);
    if (!pageGroups.has(slug)) pageGroups.set(slug, []);
    pageGroups.get(slug).push(...groupTasks);
  }

  // 3. Cap & Sequence: pack page-groups into phases greedily (largest
  //    group first, for fewer/denser phases). A single group already over
  //    the cap must still split -- an unavoidable break, never an
  //    arbitrary one, since it only happens inside one already-cohesive
  //    file/page group.
  const orderedGroups = [...pageGroups.values()].sort((a, b) => b.length - a.length);
  const rawBatches = [];
  for (const group of orderedGroups) {
    if (group.length > cap) {
      for (let i = 0; i < group.length; i += cap) rawBatches.push(group.slice(i, i + cap));
      continue;
    }
    const target = rawBatches.find((b) => b.length + group.length <= cap);
    if (target) target.push(...group);
    else rawBatches.push([...group]);
  }

  // Structural-first phase ordering: the phase containing the most
  // structural work (lowest average weight) is numbered Phase 1.
  const withWeight = rawBatches.map((batchTasks) => ({
    tasks: [...batchTasks].sort((a, b) => structuralWeight(a) - structuralWeight(b)),
  }));
  withWeight.sort((a, b) => {
    const avg = (arr) => arr.tasks.reduce((sum, t) => sum + structuralWeight(t), 0) / arr.tasks.length;
    return avg(a) - avg(b);
  });

  const totalPhases = withWeight.length;
  const phased = withWeight.map((batch, idx) => ({
    phase: idx + 1,
    totalPhases,
    tasks: batch.tasks,
    files: [...new Set(batch.tasks.map((t) => t.file || t.activeFile).filter(Boolean))],
  }));

  // 4. Collision Check: a phase is safe to dispatch in parallel with
  //    another only if the two touch fully disjoint files.
  return phased.map((batch, idx) => ({
    ...batch,
    collidesWith: phased.filter((other, otherIdx) => otherIdx !== idx && other.files.some((f) => batch.files.includes(f))).map((other) => other.phase),
  }));
}

// P12-H: the ~25-token computed-style dump (fontSize/color/lineHeight/
// margin/padding/width/height/position) that now rides along on every
// task by default, replacing an unconditional raster snapshot. Rendered
// as one compact JSON line rather than a screenshot path so a
// terminal-only coding CLI (which can't open a PNG anyway) still gets a
// real, if approximate, sense of the element's current visual footprint.
function computedStyleLine(t) {
  if (!t.computedStyle) return '';
  return `\n   - Computed Style: \`${JSON.stringify(t.computedStyle)}\``;
}

const PACKAGE_TEMPLATES = {
  claude: {
    itemFormat(t, idx) {
      const loc = t.file ? `\`${t.file}\`${t.path ? ` -> \`${t.path}\`` : ''}` : '(unmapped UI element)';
      return `${idx + 1}. **${loc}**\n   - Directive: ${t.prompt || t.rawPrompt}${t.currentValue ? `\n   - Current Value: "${t.currentValue}"` : ''}${computedStyleLine(t)}${t.shotPath ? `\n   - Local Screenshot: \`${t.shotPath}\`` : ''}`;
    },
    header(tasks, isThrottled) {
      return isThrottled
        ? `### Master UI Refactoring Directive (LOW-QUOTA FAILOVER -> CODEX)\n*Note: Claude 5-hour quota is depleted (<${LOW_QUOTA_THRESHOLD}%). Strictly follow existing design tokens in src/lib/graphic-style.ts without regressions.*`
        : `### Master UI Refactoring Directive (${tasks.length} tasks bundled for Claude Sonnet)\n*Cohesive Goal: Apply unified Apple Liquid Glass styling, typography, and layout refinements across the affected components.*`;
    },
    filesLabel: '**Consolidated Target Files:**',
    noFilesLine: '- (Inspect active layout)',
    itemsLabel: '**Actionable Step-by-Step Game Plan:**',
    footer: ['**Execution Rules:**', '- Implement all changes coherently in a single pass.', '- Preserve existing component structure and ensure 0px layout shift.'],
  },
  codex: {
    itemFormat(t, idx) {
      const loc = t.file ? `\`${t.file}\`${t.path ? ` -> \`${t.path}\`` : ''}` : '(backend script)';
      return `${idx + 1}. **${loc}**\n   - Task: ${t.prompt || t.rawPrompt}${t.currentValue ? `\n   - Context: "${t.currentValue}"` : ''}`;
    },
    header(tasks) {
      return `### Master Backend & Execution Directive (${tasks.length} tasks bundled for Codex)\n*Cohesive Goal: Execute AST, schema updates, script adjustments, and verify with unit tests.*`;
    },
    filesLabel: '**Target Files:**',
    noFilesLine: '- (Root codebase scripts)',
    itemsLabel: '**Step-by-Step Plan:**',
    footer: ['**Verification Plan:**', '- Run automated schema checks and unit tests to ensure zero compilation or AST errors.'],
  },
  gemini: {
    itemFormat(t, idx) {
      return `${idx + 1}. **Objective:** ${t.prompt || t.rawPrompt}${t.file ? ` (Scope: \`${t.file}\`)` : ''}`;
    },
    header(tasks) {
      return `### Master Architecture & Documentation Directive (${tasks.length} tasks bundled for Gemini)\n*Cohesive Goal: Perform codebase-wide analysis, cross-file synthesis, and documentation audit.*`;
    },
    filesLabel: null,
    noFilesLine: null,
    itemsLabel: '**Scope of Inquiry:**',
    footer: ['**Output Requirements:**', '- Provide a structured executive overview with concrete cross-references.', '- Identify any architectural drift or missing documentation.'],
  },
};

/**
 * Synthesizes a list of same-domain tasks into one or more master
 * directives -- one per phase, per the P12-B affinity slicer, so a bucket
 * that overruns the single-phase task cap still comes back as several
 * cleanly-sequenced, file-cohesive packages instead of one oversized blob.
 * `originalTarget` is one of 'claude'/'codex'/'gemini' (which template + who
 * this batch was semantically classified for); `targetModel` is who it's
 * actually being sent to, which can differ from `originalTarget` under a
 * quota failover.
 *
 * @returns {Array<Object>} one synthesized package per phase (empty array
 *   when `tasks` is empty).
 */
function synthesizePackage(tasks, originalTarget, { isThrottled = false, targetModel = originalTarget } = {}) {
  if (tasks.length === 0) return [];

  const template = PACKAGE_TEMPLATES[originalTarget];
  const phases = sliceIntoAffinityBatches(tasks);

  return phases.map((phase) => {
    const phaseTasks = phase.tasks;
    const files = phase.files;
    const items = phaseTasks.map((t, idx) => template.itemFormat(t, idx));

    const sections = [];
    if (phase.totalPhases > 1) {
      sections.push(`**Phase ${phase.phase} of ${phase.totalPhases}** (batch capped at ${BATCH_CAP} tasks for token-budget sizing -- run each phase in a fresh chat/session, see P12-D)`, '');
    }
    sections.push(template.header(phaseTasks, isThrottled), '');
    if (template.filesLabel) {
      sections.push(template.filesLabel, files.length > 0 ? files.map((f) => `- \`${f}\``).join('\n') : template.noFilesLine, '');
    }
    sections.push(...dualSyncDirectiveLines(phaseTasks));
    sections.push(template.itemsLabel, items.join('\n\n'), '', ...template.footer);
    const formattedPrompt = sections.join('\n');
    const reasoning = reasoningTier(phaseTasks, files);

    return {
      targetModel,
      originalTarget,
      quotaOverrideApplied: targetModel !== originalTarget,
      taskCount: phaseTasks.length,
      files,
      phase: phase.phase,
      totalPhases: phase.totalPhases,
      // Other phase numbers (within this same model's own package set) that
      // touch an overlapping file -- these must run serially in phase
      // order; a phase with an empty list here touches fully disjoint
      // files from every sibling phase and is safe to dispatch in parallel.
      collidesWithPhases: phase.collidesWith,
      formattedPrompt,
      reasoningTier: reasoning,
      // Every phase carries the Opus economics so the sheet can escalate any
      // of them by hand; `suggested` pre-sets the toggle. ~4 characters per
      // token: a rough prompt-size figure for the badge, not a tokenizer count.
      escalation: { ...OPUS_ESCALATION, suggested: reasoning === 'opus', promptTokens: Math.ceil(formattedPrompt.length / 4) },
      // Lightweight per-task view (P12-C's pre-flight review sheet) --
      // display/edit-only, never re-sent to the model itself (the model
      // only ever receives formattedPrompt).
      tasks: phaseTasks.map((t) => ({ index: t.index, file: t.file || t.activeFile || null, path: t.path || null, prompt: t.prompt || t.rawPrompt || '', currentValue: t.currentValue || null, computedStyle: t.computedStyle || null })),
    };
  });
}

/**
 * Main batch partitioner and synthesizer.
 *
 * @param {Array<Object>} tasks - List of staged tasks.
 * @param {Object} [options]
 * @param {Object} [options.quotas] - Optional quotas object. Defaults to live status bar read.
 * @returns {Object} Partitioned packages for Claude, Codex, and Gemini.
 */
export function synthesizeBatch(tasks, options = {}) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return {
      totalTasks: 0,
      breakdown: { uiTasks: 0, backendTasks: 0, planningTasks: 0 },
      quotasUsed: { claude5hRemainingPct: 100, isClaudeThrottled: false, claude7dRemainingPct: 100, codex5hRemainingPct: 100, geminiStatus: 'healthy' },
      packages: {},
      summary: 'No tasks to synthesize.',
    };
  }

  const quotas = options.quotas || readQuotas();
  // The live reader returns `claude5hRemainingPct` (see quota-reader.mjs) --
  // there is no `claude5h` field. Reading the wrong key here silently
  // disabled the entire failover path, always falling back to the `?? 100`
  // default regardless of real quota.
  const claude5hRemainingPct = quotas.claude5hRemainingPct ?? 100;
  const isClaudeThrottled = claude5hRemainingPct < LOW_QUOTA_THRESHOLD;

  const buckets = { ui_aesthetics: [], backend_ast: [], planning_synthesis: [] };
  for (const task of tasks) {
    buckets[classifyTask(task)].push(task);
  }

  const claudePhases = synthesizePackage(buckets.ui_aesthetics, 'claude', {
    isThrottled: isClaudeThrottled,
    targetModel: isClaudeThrottled ? 'codex' : 'claude',
  });
  const codexPhases = synthesizePackage(buckets.backend_ast, 'codex');
  const geminiPhases = synthesizePackage(buckets.planning_synthesis, 'gemini');

  // Keyed by *where the tasks semantically came from*, not by targetModel --
  // a throttled Claude package and a genuine Codex package both end up with
  // targetModel: 'codex', so keying by targetModel collided the two and
  // silently discarded whichever was assigned second. Each value is an
  // array of one-or-more sequenced phases (P12-B) rather than a single
  // package -- one phase is the common case, several only when a bucket
  // overran the single-phase task cap.
  const packages = {};
  if (claudePhases.length) packages[isClaudeThrottled ? 'codex_failover' : 'claude'] = claudePhases;
  if (codexPhases.length) packages.codex = codexPhases;
  if (geminiPhases.length) packages.gemini = geminiPhases;

  return {
    totalTasks: tasks.length,
    breakdown: {
      uiTasks: buckets.ui_aesthetics.length,
      backendTasks: buckets.backend_ast.length,
      planningTasks: buckets.planning_synthesis.length,
    },
    quotasUsed: {
      claude5hRemainingPct,
      isClaudeThrottled,
      // P12-C's pre-flight review sheet reads these for its live telemetry
      // row -- passed through from the same `quotas` object the failover
      // decision above already used, not a second read.
      claude7dRemainingPct: quotas.claude7dRemainingPct ?? 100,
      codex5hRemainingPct: quotas.codex5hRemainingPct ?? 100,
      geminiStatus: quotas.geminiStatus ?? 'healthy',
    },
    packages,
  };
}
