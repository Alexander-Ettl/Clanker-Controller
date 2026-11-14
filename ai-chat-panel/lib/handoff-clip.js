'use strict';

// Shortening text for a chat briefing without losing its shape. A reply that is a
// list or has headings is cut at item boundaries: every item keeps its number and
// first line, and the remaining budget goes to the item bodies, most severe first.
// Anything else keeps its opening and (mostly) its ending. Every cut leaves a marker
// "[...N chars omitted; full text: <where>...]" so the reader can fetch the original.

const HEAD_MAX = 400; // longest first line an item keeps verbatim
const PREAMBLE_MAX = 600; // text before the first item or heading
const TAIL_MAX = 1200; // the conclusion of a structured reply is always kept
const BODY_SHARE = 80; // what every item gets of its body before severity decides who gets more
const UNIT_START = [/^#{1,6}\s+\S/, /^(?:\d{1,3}[.)]|[-*•+])\s+\S/, /^\*\*[^*\n]{1,80}\*\*/];
const FENCE = /^\s*(?:```|~~~)/;
const SEVERITY = [
  [/\b(?:critical|blocker|p0|severe|data loss|security)\b/i, 4],
  [/\b(?:high|major|crash|p1|regression)\b/i, 3],
  [/\b(?:medium|bug|error|fail\w*|p2)\b/i, 2],
  [/\b(?:low|minor|nit|nitpick|cosmetic|p3)\b/i, 0],
];

function marker(omitted, where) {
  return `[...${omitted} chars omitted${where ? `; full text: ${where}` : ''}...]`;
}

/** Non-blank lines of text[from, to) as { s, e } (trailing whitespace excluded). */
function linePieces(text, from, to) {
  const out = [];
  for (let s = from; s < to;) {
    let e = text.indexOf('\n', s);
    if (e === -1 || e > to) e = to;
    let end = e;
    while (end > s && /\s/.test(text[end - 1])) end -= 1;
    if (end > s) out.push({ s, e: end });
    s = e + 1;
  }
  return out;
}

/** The last space in [from + 60% of room, from + room], else the hard limit. */
function wordCut(text, from, to, room) {
  const limit = Math.min(to, from + Math.max(0, room));
  if (limit >= to) return to;
  const space = text.lastIndexOf(' ', limit);
  return space > from + room * 0.6 ? space : limit;
}

function unitStarts(text) {
  const starts = [];
  let inFence = false;
  for (const { s, e } of linePieces(text, 0, text.length)) {
    const line = text.slice(s, e);
    if (FENCE.test(line)) inFence = !inFence;
    else if (!inFence && UNIT_START.some(pattern => pattern.test(line))) starts.push(s);
  }
  return starts;
}

/** Where a closing paragraph (a conclusion or question after the list, at most TAIL_MAX long) starts; the text length if there is none. */
function conclusionStart(text) {
  const blocks = [...text.matchAll(/\S[\s\S]*?(?=\n\s*\n|$)/g)];
  let cut = text.length;
  for (let i = blocks.length - 1; i > 0; i -= 1) {
    const { index } = blocks[i];
    const insideFence = linePieces(text, 0, index).filter(({ s, e }) => FENCE.test(text.slice(s, e))).length % 2 === 1;
    const indented = index > text.lastIndexOf('\n', index - 1) + 1;
    const startsUnit = UNIT_START.some(pattern => pattern.test(blocks[i][0].split('\n')[0]));
    if (insideFence || indented || startsUnit || text.length - index > TAIL_MAX) break;
    cut = index;
  }
  return cut;
}

const severity = (text) => SEVERITY.find(([pattern]) => pattern.test(text))?.[1] ?? 1;

function headTail(clean, budget, reserve, note) {
  const available = budget - reserve;
  // The conclusion gets most of the budget: at least 1200 characters whenever it allows.
  const head = Math.min(Math.floor(available * 0.25), Math.max(40, available - TAIL_MAX));
  let headEnd = head;
  if (head > 0) {
    const line = clean.lastIndexOf('\n', head);
    if (line > head - 200 && line > 0) headEnd = line;
  }
  let tailStart = clean.length - (available - head);
  const next = clean.indexOf('\n', tailStart);
  if (next !== -1 && next - tailStart <= 200) tailStart = next + 1;
  const kept = clean.slice(0, headEnd).trimEnd();
  return { text: `${kept}${kept ? '\n' : ''}${note(kept.length, tailStart)}\n${clean.slice(tailStart)}`, omitted: tailStart - kept.length, items: 1 };
}

function structured(clean, starts, cutAt, budget, reserve, note, where) {
  const tail = clean.slice(cutAt);
  const room = budget - (tail ? tail.length + 1 : 0);
  const build = (cap) => {
    const parts = starts.map((start, i) => {
      const end = i + 1 < starts.length ? starts[i + 1] : cutAt;
      const [first, ...rest] = linePieces(clean, start, end);
      let head = first;
      if (first.e - first.s > cap) {
        const cut = wordCut(clean, first.s, first.e, cap);
        head = { s: first.s, e: cut };
        rest.unshift({ s: cut, e: first.e });
      }
      return { start, end, head, rest, granted: 0, partial: -1, spent: 0, limit: Infinity, rank: severity(clean.slice(start, start + 300)) };
    });
    if (starts[0] > 0) parts.unshift({ start: 0, end: starts[0], head: null, rest: linePieces(clean, 0, starts[0]), granted: 0, partial: -1, spent: 0, limit: PREAMBLE_MAX, rank: 9 });
    return parts;
  };
  const headCost = (parts) => parts.reduce((sum, part) => sum + (part.head ? part.head.e - part.head.s + 1 : 0), 0);
  const lastEnd = (part) => (part.rest.length ? part.rest[part.rest.length - 1].e : part.head.e);
  const cutStart = (part) => (part.partial >= 0 ? part.partial : part.granted < part.rest.length ? part.rest[part.granted].s : -1);
  const out = [];
  let omitted = 0;
  let items = 0;

  let parts = build(HEAD_MAX);
  if (headCost(parts) + parts.length * reserve <= room) {
    // Every item may end in its own marker: spend the rest on bodies, fair share first, then most severe first.
    const incomplete = () => parts.filter(part => cutStart(part) >= 0).length;
    const slack = () => room - headCost(parts) - parts.reduce((sum, part) => sum + part.spent, 0) - incomplete() * reserve;
    const cost = (part, index) => part.rest[index].e - (index ? part.rest[index - 1].e : part.head ? part.head.e : part.rest[index].s);
    const grant = (part, allow) => {
      allow = Math.min(allow, part.limit - part.spent);
      // The piece being filled may already be cut part-way (`partial`): continue from there.
      const price = (index) => (index === part.granted && part.partial >= 0 ? part.rest[index].e - part.partial : cost(part, index));
      const remaining = part.rest.slice(part.granted).reduce((sum, _, i) => sum + price(part.granted + i), 0);
      if (remaining <= allow + reserve && remaining <= part.limit - part.spent) allow = remaining;
      while (part.granted < part.rest.length) {
        const piece = part.rest[part.granted];
        const next = price(part.granted);
        if (next <= allow) { part.granted += 1; part.spent += next; allow -= next; part.partial = -1; continue; }
        const resumed = part.partial >= 0;
        const from = resumed ? part.partial : piece.s;
        const lead = resumed ? 0 : piece.s - (part.granted ? part.rest[part.granted - 1].e : part.head ? part.head.e : piece.s);
        if (allow >= (resumed ? 20 : 60)) {
          const cut = wordCut(clean, from, piece.e, allow - lead - 1);
          if (cut > from) { part.partial = cut; part.spent += lead + cut - from; }
        }
        break;
      }
    };
    const order = [...parts].sort((a, b) => b.rank - a.rank || a.start - b.start);
    // Every item first gets a small taste of its body; what is left goes to the most severe, then the earliest.
    const share = Math.min(BODY_SHARE, Math.max(0, Math.floor(slack() / parts.length)));
    for (const part of order) grant(part, share);
    for (let round = 0; round < 3; round += 1) for (const part of order) if (cutStart(part) >= 0) grant(part, Math.max(0, slack()));
    for (const part of parts) {
      let text = part.head ? clean.slice(part.head.s, part.head.e) : '';
      let previous = part.head ? part.head.e : -1;
      for (const piece of part.rest.slice(0, part.granted)) {
        const gap = previous < 0 ? '' : piece.s === previous ? '' : (clean.slice(previous, piece.s).match(/\n/g) || []).length > 1 ? '\n\n' : '\n';
        text += gap + clean.slice(piece.s, piece.e);
        previous = piece.e;
      }
      if (part.partial >= 0) {
        const piece = part.rest[part.granted];
        text += (previous < 0 || piece.s === previous ? '' : '\n') + clean.slice(piece.s, part.partial);
      }
      const from = cutStart(part);
      if (from >= 0) {
        const to = lastEnd(part);
        text += `\n  ${note(from, to)}`;
        omitted += to - from;
        items += 1;
      }
      out.push(text);
    }
  } else {
    // Too little room for a marker per item: keep every item's first line and one marker for all the bodies.
    for (const cap of [HEAD_MAX, 160, 100, 60]) {
      parts = build(cap);
      if (headCost(parts) + reserve <= room) break;
    }
    const preamble = parts[0].head ? null : parts.shift();
    let spare = room - reserve;
    let first = Infinity;
    let hidden = 0;
    const lines = [];
    for (const part of parts) {
      const price = part.head.e - part.head.s + 1;
      if (spare < price) { first = Math.min(first, part.start); hidden += cutAt - part.start; break; }
      spare -= price;
      lines.push(clean.slice(part.head.s, part.head.e) + (part.rest[0]?.s === part.head.e ? ' …' : ''));
      if (part.rest.length) { first = Math.min(first, part.rest[0].s); hidden += lastEnd(part) - part.rest[0].s; }
    }
    if (preamble) {
      const end = lastEnd(preamble);
      const stop = spare >= 60 ? wordCut(clean, preamble.rest[0].s, end, Math.min(PREAMBLE_MAX, spare)) : preamble.rest[0].s;
      if (stop > preamble.rest[0].s) lines.unshift(clean.slice(preamble.rest[0].s, stop));
      if (stop < end) { first = Math.min(first, stop); hidden += end - stop; }
    }
    out.push(...lines);
    if (hidden > 0) {
      out.push(marker(hidden, where(first)));
      omitted += hidden;
      items += 1;
    }
  }
  if (tail) out.push(tail);
  return { text: out.join('\n'), omitted, items };
}

/**
 * `raw` shortened to about `max` characters.
 * @param {{ at: (offset: number) => string }} [ref] where the full text lives, given an offset into `raw`
 * @returns {{ text: string, omitted: number, items: number }} items: how many markers the text now carries
 */
function clipText(raw, max, ref = null) {
  const text = String(raw ?? '');
  const lead = text.length - text.trimStart().length;
  const clean = text.trim();
  if (clean.length <= max) return { text: clean, omitted: 0, items: 0 };
  // Point at the first visible character of the omitted part, not at the line break before it.
  const where = (offset) => ref?.at(lead + offset + (clean.slice(offset).match(/^\s*/)[0].length));
  const note = (from, to) => marker(to - from, where(from));
  const reserve = marker(9999999, ref?.at(0)).length + 10; // marker, its line breaks, and room for longer line numbers
  const budget = Math.floor(max);
  if (budget < reserve + 40) return { text: note(0, clean.length), omitted: clean.length, items: 1 };
  const cutAt = conclusionStart(clean);
  const starts = unitStarts(clean).filter(start => start < cutAt);
  if (starts.length >= 3 && cutAt - starts[0] >= cutAt * 0.5) {
    const result = structured(clean, starts, cutAt, budget, reserve, note, where);
    if (result.text.length <= budget) return result;
  }
  return headTail(clean, budget, reserve, note);
}

/** First sentence (or line) of a message, at most `max` characters, and how much of the message it covers. */
function digestOf(raw, max = 160) {
  const text = String(raw ?? '');
  const lead = text.length - text.trimStart().length;
  const clean = text.trim();
  const sentence = /^[\s\S]*?[.!?:](?=\s|$)/.exec(clean);
  const line = clean.indexOf('\n');
  let end = Math.min(sentence ? sentence[0].length : clean.length, line === -1 ? clean.length : line);
  if (end > max) end = wordCut(clean, 0, clean.length, max - 1);
  if (clean.length - end < 24) end = clean.length;
  return { text: clean.slice(0, end).trimEnd(), end: lead + end, omitted: clean.length - end };
}

module.exports = { clipText, digestOf, marker };
