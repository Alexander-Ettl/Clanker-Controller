// Generates docs/plans/recent-chat-context-icons-rating.html: every work icon on the Claude, Codex and Antigravity tiles, with star ratings.
// Also shows the proposed non-coding categories (recent-chat-context-icons-proposed.json, icons in context-icons-proposed/).
// Usage: node make-rating-page.cjs [repo root]   (default: the repo this file is in)
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = process.argv[2] || path.resolve(__dirname, '..', '..');
const panel = path.join(root, 'ai-chat-panel');
const { categories: current } = require(path.join(panel, 'lib', 'work-context-categories.json'));
const { categories: proposed } = require(path.join(root, 'docs', 'plans', 'recent-chat-context-icons-proposed.json'));
const categories = [...current, ...proposed];

// The provider marks, exactly as the rail gets them.
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(panel, 'media', 'agent-icons.js'), 'utf8'), sandbox);
const logo = (agent) => sandbox.window.AGENT_ICONS[agent]; // a copy with its own ids on every read

// The tile's outline: bubblePath() from media/bubble-shape.js with the rail's 6px tail (copied: the file needs a DOM).
function bubblePath(w, h, tail = 6) {
  const N = 5, STEPS = 16, RADIUS = 20, K = tail / 6, body = h - tail;
  const r = Math.min(RADIUS, w / 2, body / 2);
  const xv = w - 9 * K, xl = xv - 8.6 * K;
  const bottom = (x) => { const dx = x - (w - r); return dx <= 0 ? body : body - r + r * (1 - (dx / r) ** N) ** (1 / N); };
  const corner = (cx, cy, from) => Array.from({ length: STEPS + 1 }, (_, k) => {
    const t = from + (Math.PI / 2) * (k / STEPS), c = Math.cos(t), s = Math.sin(t);
    return [cx + r * Math.sign(c) * Math.abs(c) ** (2 / N), cy + r * Math.sign(s) * Math.abs(s) ** (2 / N)];
  });
  const points = [...corner(w - r, r, 1.5 * Math.PI), ...corner(w - r, body - r, 0), ...corner(r, body - r, 0.5 * Math.PI), ...corner(r, r, Math.PI)];
  const f = (x, y) => `${x.toFixed(2)} ${y.toFixed(2)}`;
  let d = '', tailDone = false;
  for (const [x, y] of points) {
    if (y > body - r && x < xv && x > xl) {
      if (!tailDone) d += `L${f(xv, bottom(xv))}L${f(xv, body + 4.6 * K)}Q${f(xv, body + 6.4 * K)} ${f(xv - 1.4 * K, body + 5.3 * K)}L${f(xl, bottom(xl))}`;
      tailDone = true; continue;
    }
    d += `${d ? 'L' : 'M'}${f(x, y)}`;
  }
  return `${d}Z`;
}
const outline = bubblePath(40, 46);
let uid = 0;
const tile = (agent) => {
  const id = ++uid;
  return `<span class="tile"><svg class="shape" viewBox="0 0 40 46" aria-hidden="true"><defs><clipPath id="c${id}"><path d="${outline}"/></clipPath><linearGradient id="g${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".09"/><stop offset=".45" stop-color="#fff" stop-opacity="0"/></linearGradient></defs><g clip-path="url(#c${id})"><path d="${outline}" fill="#1d1e24"/><path d="${outline}" fill="url(#g${id})"/><path d="${outline}" fill="none" stroke="rgba(255,255,255,.14)" stroke-width="2" stroke-linejoin="round"/></g></svg><span class="logo">${logo(agent)}</span></span>`;
};
const AGENTS = [['claude', 'Claude'], ['codex', 'Codex'], ['gemini', 'Antigravity']];

const card = ({ id, label, symbol, example }, fresh) => {
  const svg = fs.readFileSync(fresh ? path.join(root, 'docs', 'plans', 'context-icons-proposed', `${id}.svg`) : path.join(panel, 'media', 'context-icons', `${id}.svg`), 'utf8').trim();
  const tiles = AGENTS.map(([agent, name]) => `<figure class="item" data-agent="${agent}">${tile(agent)}<span class="disc">${svg}</span><figcaption>${name}</figcaption></figure>`).join('');
  return `<article class="card" data-id="${id}" data-new="${fresh}"><header><div class="name"><h2>${label}${fresh ? '<span class="badge">new</span>' : ''}</h2><span class="sym">${symbol}</span>${fresh ? `<span class="eg">“${example}”</span>` : ''}</div><div class="solo" title="The icon on its own">${svg}</div></header><div class="stage"><div class="tiles">${tiles}</div></div><div class="rate" role="radiogroup" aria-label="${label}: rating">${[1, 2, 3, 4, 5].map((n) => `<button type="button" role="radio" aria-checked="false" data-n="${n}" aria-label="${n} of 5"><svg viewBox="0 0 24 24"><path d="M12 3.3l2.7 5.5 6 .9-4.4 4.2 1 6-5.3-2.8-5.4 2.8 1.1-6-4.3-4.2 6-.9z"/></svg></button>`).join('')}<button type="button" class="clear" aria-label="Clear rating">clear</button></div></article>`;
};
const cards = current.map((c) => card(c, false)).join('\n');
const newCards = proposed.map((c) => card(c, true)).join('\n');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Recent tab work icons: rate them</title>
<style>
:root { --bg: #111216; --card: rgb(26, 28, 34); --line: rgba(255, 255, 255, .12); --text: #f5f5f7; --mute: #98989d; --claude: #f97316; --codex: #8b5cf6; --gemini: #0ea5e9; --star: #ffd60a; --z: 2; color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; padding: 32px clamp(16px, 4vw, 48px) 64px; background: var(--bg); color: var(--text); font: 14px/1.45 -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', system-ui, 'Segoe UI', sans-serif; }
.top { position: sticky; top: 0; z-index: 5; margin: -32px calc(-1 * clamp(16px, 4vw, 48px)) 24px; padding: 14px clamp(16px, 4vw, 48px); display: flex; flex-wrap: wrap; align-items: center; gap: 12px 20px; background: rgba(17, 18, 22, .86); backdrop-filter: blur(14px); border-bottom: 1px solid var(--line); }
h1 { margin: 0; font-size: 17px; font-weight: 650; letter-spacing: -.01em; }
.hint { margin: 0; color: var(--mute); font-size: 12.5px; }
.top .grow { flex: 1 1 240px; }
.seg { display: inline-flex; padding: 2px; border: 1px solid var(--line); border-radius: 999px; background: rgba(255, 255, 255, .04); }
.seg button { border: 0; border-radius: 999px; padding: 4px 12px; font: inherit; font-size: 12.5px; color: var(--mute); background: none; cursor: pointer; }
.seg button[aria-pressed='true'] { color: var(--text); background: rgba(255, 255, 255, .14); }
.btn { border: 1px solid var(--line); border-radius: 999px; padding: 5px 14px; font: inherit; font-size: 12.5px; color: var(--text); background: rgba(255, 255, 255, .06); cursor: pointer; }
.btn:hover { background: rgba(255, 255, 255, .12); }
.count { color: var(--mute); font-size: 12.5px; font-variant-numeric: tabular-nums; }
button:focus-visible { outline: 2px solid #64d2ff; outline-offset: 2px; }

.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(calc(70px + 160px * var(--z)), 1fr)); gap: 16px; }
.card { display: flex; flex-direction: column; gap: 14px; padding: 16px 18px 14px; border: 1px solid var(--line); border-radius: 18px; background: var(--card); box-shadow: inset 0 1px 0 rgba(255, 255, 255, .05); }
.card header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.name { display: flex; flex-direction: column; gap: 1px; }
.card h2 { margin: 0; font-size: 15px; font-weight: 650; letter-spacing: -.01em; }
.sym { color: var(--mute); font-size: 12px; }
.eg { margin-top: 5px; color: rgba(255, 255, 255, .62); font-size: 12px; font-style: italic; line-height: 1.35; }
.badge { margin-left: 8px; padding: 1px 7px; border-radius: 999px; background: rgba(100, 210, 255, .16); color: #64d2ff; font-size: 10.5px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; vertical-align: 2px; }
h2.section { margin: 36px 0 14px; font-size: 15px; font-weight: 650; letter-spacing: -.01em; }
h2.section:first-of-type { margin-top: 0; }
h2.section span { margin-left: 6px; color: var(--mute); font-weight: 500; font-variant-numeric: tabular-nums; }
.intro { margin: -6px 0 14px; }

.stage { margin-top: auto; display: flex; align-items: center; justify-content: center; padding: 14px 10px 6px; border-radius: 12px; background: var(--bg); zoom: var(--z); }
.tiles { display: flex; gap: 22px; padding-left: 6px; }
.item { position: relative; margin: 0; width: 40px; display: flex; flex-direction: column; align-items: center; gap: 2px; --agent: var(--claude); }
.item[data-agent='codex'] { --agent: var(--codex); }
.item[data-agent='gemini'] { --agent: var(--gemini); }
.tile { position: relative; display: grid; place-items: center; width: 40px; height: 46px; padding-bottom: 6px; }
.shape { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.logo { position: relative; display: grid; place-items: center; }
.logo .agent-logo { width: 22px; height: 22px; }
/* The disc is the rail's own (.history-context in launcher.css), same size, place and colours. */
.disc { position: absolute; left: -6px; top: 28px; display: grid; place-items: center; width: 19px; height: 19px; border-radius: 50%; background: rgb(26, 28, 34); box-shadow: 0 0 0 1px color-mix(in srgb, var(--agent) 38%, rgba(255, 255, 255, .1)), 0 2px 5px rgba(0, 0, 0, .4); color: color-mix(in srgb, var(--agent) 62%, #fff); }
.disc svg { width: 12px; height: 12px; display: block; }
.item figcaption { margin-top: 3px; font-size: 5.5px; letter-spacing: .02em; color: var(--mute); white-space: nowrap; }
.solo { flex: none; width: 28px; height: 28px; color: var(--text); opacity: .9; }
.solo svg { width: 100%; height: 100%; display: block; }

.rate { display: flex; align-items: center; gap: 2px; }
.rate button { display: grid; place-items: center; width: 30px; height: 30px; padding: 0; border: 0; border-radius: 8px; background: none; color: rgba(255, 255, 255, .28); cursor: pointer; transition: color .12s, transform .15s; }
.rate button svg { width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linejoin: round; }
.rate:hover button:not(.clear) { color: rgba(255, 255, 255, .5); }
.rate button:not(.clear):hover { transform: scale(1.12); }
.rate button.on svg { fill: currentColor; }
.rate button.on { color: var(--star) !important; }
.rate button.clear { width: auto; margin-left: auto; padding: 0 6px; font: inherit; font-size: 11.5px; color: var(--mute); visibility: hidden; }
.card.rated .clear { visibility: visible; }
.rate:has(button:not(.clear):hover) button.pre { color: var(--star); }
@media (prefers-reduced-motion: reduce) { .rate button { transition: none; } }
</style>
</head>
<body>
<div class="top">
  <div class="grow">
    <h1>Recent tab work icons</h1>
    <p class="hint">Each icon sits on the lower-left of the chat tile, tinted with that agent's colour, exactly as in the sidebar. Rate 1–5 stars; ratings stay in this browser.</p>
  </div>
  <div class="seg" role="group" aria-label="Size"><button type="button" data-z="1" aria-pressed="false">Actual</button><button type="button" data-z="2" aria-pressed="true">2×</button><button type="button" data-z="3" aria-pressed="false">3×</button></div>
  <span class="count" id="count">0 / ${categories.length} rated</span>
  <button class="btn" type="button" id="copy">Copy ratings</button>
</div>
<h2 class="section">Current categories <span>${current.length}</span></h2>
<main class="grid">
${cards}
</main>
<h2 class="section">Proposed: studying, protocols, planning and information management <span>${proposed.length}</span></h2>
<p class="hint intro">For work that is not coding. The quoted line is an example of a request that would pick the icon. They are not wired into Clanker yet.</p>
<main class="grid">
${newCards}
</main>
<script>
(() => {
  const KEY = 'clanker-context-icon-ratings';
  let ratings = {};
  try { ratings = JSON.parse(localStorage.getItem(KEY)) || {}; } catch {}
  const cards = [...document.querySelectorAll('.card')];
  const count = document.getElementById('count');
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(ratings)); } catch {} };
  function paint(card) {
    const value = ratings[card.dataset.id] || 0;
    card.classList.toggle('rated', value > 0);
    card.querySelectorAll('button[data-n]').forEach((button) => {
      const n = +button.dataset.n;
      button.classList.toggle('on', n <= value);
      button.setAttribute('aria-checked', String(n === value));
    });
    count.textContent = Object.values(ratings).filter(Boolean).length + ' / ' + cards.length + ' rated';
  }
  cards.forEach((card) => {
    paint(card);
    const stars = [...card.querySelectorAll('button[data-n]')];
    card.querySelector('.rate').addEventListener('mouseover', (event) => {
      const hovered = event.target.closest('button[data-n]');
      stars.forEach((star) => star.classList.toggle('pre', !!hovered && +star.dataset.n <= +hovered.dataset.n));
    });
    card.querySelector('.rate').addEventListener('mouseleave', () => stars.forEach((star) => star.classList.remove('pre')));
    card.addEventListener('click', (event) => {
      const star = event.target.closest('button[data-n]');
      const clear = event.target.closest('.clear');
      if (!star && !clear) return;
      if (clear || ratings[card.dataset.id] === +star.dataset.n) delete ratings[card.dataset.id];
      else ratings[card.dataset.id] = +star.dataset.n;
      save(); paint(card);
    });
  });
  document.querySelectorAll('.seg button').forEach((button) => button.addEventListener('click', () => {
    document.documentElement.style.setProperty('--z', button.dataset.z);
    document.querySelectorAll('.seg button').forEach((other) => other.setAttribute('aria-pressed', String(other === button)));
  }));
  document.getElementById('copy').addEventListener('click', async (event) => {
    const text = cards.map((card) => card.querySelector('h2').firstChild.textContent + ' (' + card.dataset.id + (card.dataset.new === 'true' ? ', new' : '') + '): ' + (ratings[card.dataset.id] ? ratings[card.dataset.id] + '/5' : 'not rated')).join('\\n');
    try { await navigator.clipboard.writeText(text); event.target.textContent = 'Copied'; }
    catch { window.prompt('Copy your ratings:', text); }
    setTimeout(() => { event.target.textContent = 'Copy ratings'; }, 1500);
  });
})();
</script>
</body>
</html>
`;
const out = path.join(root, 'docs', 'plans', 'recent-chat-context-icons-rating.html');
fs.writeFileSync(out, html);
console.log('wrote', out, html.length, 'bytes');
