'use strict';

// "Scan all projects": reads each registered project's folder (voice-scan.js), brings that project's scanned words up
// to date (voice-dictionary.js applyScan) and reports what happened per project. Projects are scanned one after the
// other, so a big project cannot starve the extension host; a project without a folder, or one that fails, never stops
// the rest.

const fs = require('node:fs');
const { scanProject } = require('./voice-scan');
const dictionary = require('./voice-dictionary');

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/**
 * @param {Array<{ id: string, name: string, root?: string|null }>} projects
 * @param {{ paths: object, onProgress?: (text: string) => void, scan?: typeof scanProject }} options
 * @returns {Promise<{ report: object[], notice: string, error: string }>} `error` is set when nothing could be scanned
 */
async function scanProjects(projects, { paths, onProgress = () => {}, scan = scanProject } = {}) {
  const report = [];
  for (const [index, project] of projects.entries()) {
    if (!project.root || !fs.existsSync(project.root)) { report.push({ name: project.name, status: 'no-folder' }); continue; }
    onProgress(`Scanning ${project.name} (${index + 1} of ${projects.length})…`);
    try {
      const { entries, stats } = await scan(project.root, { name: project.name });
      const result = dictionary.applyScan(paths, project.id, entries, { projectName: project.name, partial: stats.truncated || stats.incomplete });
      report.push({ name: project.name, status: 'ok', files: stats.files, found: entries.length, added: result.added, updated: result.updated, removed: result.removed, truncated: stats.truncated, full: result.full });
    } catch (error) { report.push({ name: project.name, status: 'error', message: error.message }); }
  }
  const scanned = report.filter((item) => item.status === 'ok');
  const failed = report.filter((item) => item.status === 'error');
  const skipped = report.filter((item) => item.status === 'no-folder').length;
  const sum = (field) => scanned.reduce((total, item) => total + item[field], 0);
  const outcome = { report, notice: '', error: '' };
  if (!scanned.length) {
    outcome.error = failed.length ? `Could not scan ${failed[0].name}: ${failed[0].message}`
      : projects.length === 1 ? 'That project has no folder to scan.' : 'None of the projects has a folder to scan.';
  } else if (projects.length === 1) {
    const [only] = scanned;
    outcome.notice = `${only.name}: read ${plural(only.files, 'file')}, added ${plural(only.added, 'word')}, refreshed ${only.updated}${only.removed ? `, dropped ${only.removed} stale` : ''}${only.truncated ? ' (a large project: the scan stopped early)' : ''}.${only.full ? ' This project reached its limit for scanned words.' : ''}`;
  } else {
    outcome.notice = `Scanned ${plural(scanned.length, 'project')}: added ${plural(sum('added'), 'word')}, refreshed ${sum('updated')}${sum('removed') ? `, dropped ${sum('removed')} stale` : ''}.${skipped ? ` ${skipped} had no folder.` : ''}${failed.length ? ` ${failed.length} could not be read.` : ''}`;
  }
  return outcome;
}

module.exports = { scanProjects };
