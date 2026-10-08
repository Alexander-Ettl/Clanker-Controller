'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {evaluate}=require('../../scripts/router-evaluate.cjs');
test('evaluation never counts historical model selections as human labels or synthetic confidence as Clef confidence',()=>{
  const result=evaluate([{tier:'deterministic',pick:'a',confidence:1,original_pick:'a'},{tier:'cloudflare',pick:'b',semantic_pick:'b',confidence:.2,original_pick:'b'}]);
  assert.equal(result.labeled,0);assert.equal(result.clef_mean_confidence,.2);
  assert.equal(result.results[0].unlabeled,2);assert.equal(result.results[0].correct,0);
});
test('lower gates expose wrong semantic picks; unrecorded fallback is marked unknown',()=>{
  const result=evaluate([{tier:'cloudflare',pick:'correct',semantic_pick:'wrong',confidence:.25,used_default:true,expected_pick:'correct'},
    {tier:'cloudflare',pick:'correct',semantic_pick:'correct',confidence:.45,used_default:false,better_model:'correct'}]);
  assert.equal(result.results.find(r=>r.name==='20% confidence').wrong,1);
  assert.equal(result.results.find(r=>r.name==='40% confidence').correct,2);
  assert.equal(result.results.find(r=>r.name==='65% confidence').unknown,1);
});
