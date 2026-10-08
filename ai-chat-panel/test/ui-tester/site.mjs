#!/usr/bin/env node
// Visual tester for any web page, used by the loop. Same measurements as run.mjs (overlap, clipping, covered controls, overflow,
// accessibility tree, console errors, failed requests, pixel diff against the last accepted run), but on addresses instead of the
// chat window. No model is used. Run from this extension folder so `playwright` resolves:
//   node ai-chat-panel/test/ui-tester/site.mjs --base=http://127.0.0.1:4321 --routes=/,/about --out=<dir> --baseline=<dir> [--accept] [--widths=1280,768,390]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTester } from './run.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const base = flag('base');
if (!base) { console.error('Missing --base=<address>.'); process.exit(2); }
const routes = (flag('routes', '/') || '/').split(',').map(route => route.trim()).filter(Boolean);
const widths = (flag('widths', '1280,768,390')).split(',').map(Number).filter(width => width >= 200 && width <= 3000);
const slug = route => route === '/' ? 'home' : route.replace(/^\/|\/$/g, '').replace(/[^\w-]+/g, '-').slice(0, 40);
const scenarios = routes.map(route => ({ id: `page-${slug(route)}`, url: new URL(route, base).href, height: 900 }));
const outDir = flag('out', fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-site-')));
const baselineDir = flag('baseline', path.join(outDir, 'baseline'));
const report = await runTester({ scenarios, outDir, baselineDir, widths, accept: args.includes('--accept'), update: args.includes('--update'), log: line => console.log(line) });
console.log(`\n${JSON.stringify(report.summary)}\nreport: ${path.join(outDir, 'report.md')}`);
