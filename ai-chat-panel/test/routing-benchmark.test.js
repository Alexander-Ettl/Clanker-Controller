'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { report, benchmark } = require('../lib/routing-benchmark');

test('feedback comparison restores full requests and excludes explicitly rejected samples',t=>{
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'router-feedback-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'feedback.json');
  fs.writeFileSync(file,JSON.stringify({version:1,feedback:[{prompt:'Fix the backend',screenshot:false,better_model:'sol',pick:'sonnet',confidence:.2},{prompt:'Stop asking',note:'not a prompt I would ever sent through auto'}]}));
  const {feedbackSample}=require('../lib/routing-benchmark');
  const rows=feedbackSample([{prompt:'Fix the backend and preserve sessions',screenshot:false}],file,10);
  assert.equal(rows.length,1);assert.equal(rows[0].prompt,'Fix the backend and preserve sessions');assert.equal(rows[0].expected_pick,'sol');
  assert.throws(()=>feedbackSample([],file,10),/refusing to route a truncated snippet/);
});

test('smoke report exposes escaped fallback reasons for unexercised tiers', () => {
  const html = report([{ prompt: 'Fix heading', pick: 'fast', confidence: 1, tier: 'deterministic', latency_ms: 2,
    action: 'continue', reason: 'session compatible', attempts: [
      { tier: 'cloudflare', status: 'fallback', reason: 'connection missing' },
      { tier: 'groq', status: 'fallback', reason: '<script>untrusted</script>' },
    ] }], [{ id: 'fast' }]);
  assert.ok(html.includes('<small>cloudflare: connection missing</small>'));
  assert.ok(html.includes('<small>groq: &lt;script&gt;untrusted&lt;/script&gt;</small>'));
  assert.ok(!html.includes('<script>untrusted</script>'));
});

test('benchmarks above ten remain locked before reading history or calling a router', async () => {
  let called = false;
  await assert.rejects(benchmark({ n: 50, router: { route() { called = true; } } }), /locked until you confirm/);
  assert.equal(called, false);
});

test('report distinguishes a low-confidence proposal from the selected default',()=>{
  const html=report([{prompt:'Investigate',pick:'fast',semantic_pick:'deep',used_default:true,confidence:.3,tier:'cloudflare',candidate_probabilities:{deep:.3,fast:.7}}],[{id:'fast'},{id:'deep'}]);
  assert.ok(html.includes('proposal deep, using default/ranking'));
  assert.ok(html.includes('deep: 30.00%'));
});
