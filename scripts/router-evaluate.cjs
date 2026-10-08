'use strict';
const fs=require('node:fs');

function readRows(file) {
  const text=fs.readFileSync(file,'utf8');
  const data=file.endsWith('.html') ? JSON.parse(/const rows=([\s\S]*?);document\.getElementById/.exec(text)?.[1]||'null') : JSON.parse(text);
  const rows=Array.isArray(data)?data:data?.feedback;
  if(!Array.isArray(rows))throw Error('Expected a router report or feedback JSON');
  return rows.filter(r=>!r.exclude && !/not a prompt|never.*auto|ever sent.*auto/i.test(r.note||''));
}
function evaluate(rows) {
  const strategies=[['Current final choice',r=>r.pick],['Clef top choice',()=>true],
    ...[.1,.2,.3,.4,.5,.65].map(t=>[`${t*100}% confidence`,r=>r.confidence>=t]),
    ['70% candidate probability',r=>(r.candidate_probabilities?.[r.semantic_pick]||0)>=.7],
    ['20% confidence + 50-point margin',r=>{const p=Object.values(r.candidate_probabilities||{}).filter(Number.isFinite).sort((a,b)=>b-a);return r.confidence>=.2 && p.length>=2 && p[0]-p[1]>=.5;}]];
  const live=rows.filter(r=>r.tier==='cloudflare' && r.semantic_pick && Number.isFinite(r.confidence));
  const results=strategies.map(([name,gate])=>{
    let correct=0,wrong=0,unlabeled=0,unknown=0,accepted=0;
    const counts={};
    for(const r of rows) {
      let pick;
      if(name==='Current final choice' || r.tier!=='cloudflare' || !r.semantic_pick)pick=r.pick;
      else if(gate(r)){pick=r.semantic_pick;accepted++;}
      else if(r.used_default)pick=r.pick;
      else {unknown++;continue;} // A counterfactual fallback was never recorded.
      if(pick)counts[pick]=(counts[pick]||0)+1;
      const expected=r.better_model||r.expected_pick;
      if(!expected){unlabeled++;continue;}
      if(pick===expected)correct++;else wrong++;
    }
    return {name,correct,wrong,unlabeled,unknown,accepted,distribution:counts};
  });
  return {requests:rows.length,labeled:rows.filter(r=>r.better_model||r.expected_pick).length,
    clef_responses:live.length,clef_mean_confidence:live.length?live.reduce((n,r)=>n+r.confidence,0)/live.length:null,
    provider_errors:rows.flatMap(r=>r.attempts||[]).filter(a=>a.status==='fallback'),results,
    limitation:'Offline replay of recorded final responses. Higher gates may require unrecorded fallback decisions; different gates can change retries. Provider errors keep their recorded final pick. The labeled tuning set does not establish accuracy on new tasks.'};
}
if(require.main===module) {
  try {
    const [file,...args]=process.argv.slice(2);if(!file)throw Error('Usage: node scripts/router-evaluate.cjs <report.html|feedback.json> [--feedback labels.json] [--out results.json]');
    let rows=readRows(file),out;
    for(let i=0;i<args.length;i++) {
      if(args[i]==='--out')out=args[++i];
      else if(args[i]==='--feedback') {
        const labels=readRows(args[++i]);
        rows=rows.map(r=>{const label=labels.find(l=>l.prompt===r.prompt && l.screenshot===r.screenshot && l.project===r.project);return label?{...r,better_model:label.better_model,note:label.note}:r;});
      } else throw Error('Unknown option: '+args[i]);
    }
    const result=evaluate(rows);
    if(out)fs.writeFileSync(out,JSON.stringify(result,null,2));
    console.log(`${result.requests} requests; ${result.labeled} labeled; ${result.clef_responses} Clef responses`);
    console.table(result.results.map(({distribution,...r})=>r));
    console.log(result.limitation);
  }catch(error){console.error(error.message);process.exitCode=1;}
}
module.exports={readRows,evaluate};
