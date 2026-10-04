'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {Router,config,redact,continuity,GROQ_MODEL}=require('../lib/routing');
const fast={id:'fast',agent:'codex',effort:'low',context:10000,vision:true,complexity:.25};
const deep={id:'deep',agent:'codex',effort:'high',context:20000,vision:true,complexity:.85};
const other={id:'other',agent:'claude',context:40000,vision:false,complexity:.5};
const models=[fast,deep,other];
function make(settings={},fetchImpl) {const logs=[],calls=[];let usage={};const secrets={get:async k=>k==='routingCloudflareAccount'?'a'.repeat(32):'test-secret-value'};const router=new Router({getConfig:()=>({router_mode:'auto',...settings}),secrets,store:{get:()=>usage,set:u=>usage=u},fetchImpl:async(url,req)=>{calls.push({url,body:JSON.parse(req.body)});return fetchImpl?fetchImpl(url,req):cf('deep');},log:r=>logs.push(r)});return {router,logs,calls};}
const cf=(pick='deep',confidence=.9)=>({ok:true,status:200,json:async()=>({result:{answers:{pick:{choice:pick,confidence,probabilities:{fast:1-confidence,deep:confidence}},complexity:{score:2.55},needs_vision:{noul:0},needs_long_context:{noul:0},continuation:{noul:1}}}})});
const groq=()=>({ok:true,status:200,json:async()=>({choices:[{message:{content:JSON.stringify({pick:'fast',confidence:.9,complexity:.2,needs_vision:false,needs_long_context:false,continuation:true})}}]})});
test('Clef sends several typed questions, redacts credentials, and parses the published answer schema',async()=>{const {router,calls,logs}=make();const r=await router.route({prompt:'Debug architecture token=test-secret-value',project:'x'},models);assert.equal(r.tier,'cloudflare');assert.equal(r.pick,'deep');assert.equal(r.action,'continue');assert.equal(calls[0].body.model,'clef-flash');assert.equal(Object.keys(calls[0].body.questions).length,5);assert.ok(!JSON.stringify(calls).includes('test-secret-value'));assert.ok(!JSON.stringify(logs).includes('test-secret-value'));});
test('429 and 3036 fall to Groq; exhausted primary is skipped on subsequent calls',async()=>{for(const status of [429,400]){const {router,calls}=make({},async url=>url.includes('cloudflare')?{ok:false,status,json:async()=>({errors:[{code:3036,message:'allocation used'}]})}:groq());assert.equal((await router.route({prompt:'Rename field',project:'p'},models)).tier,'groq');assert.equal((await router.route({prompt:'Rename field',project:'p'},models)).tier,'groq');assert.equal(calls.filter(c=>c.url.includes('cloudflare')).length,1);}});
test('timeout or two unavailable services fall through without blocking',async()=>{const {router}=make({},async()=>{throw Error('timeout');});assert.equal((await router.route({prompt:'Fix a typo'},models)).tier,'deterministic');});
test('disabled tiers and private projects make no external requests',async()=>{for(const settings of [{tiers:['deterministic']},{never_send:['private']},{primary:'deterministic'}]){const {router,calls}=make(settings);assert.equal((await router.route({prompt:'Investigate',project:'private'},models)).tier,'deterministic');assert.equal(calls.length,0);}});
test('low confidence retries exactly once on regular Clef then uses configured default',async()=>{const {router,calls}=make({default_model:'fast'},async()=>cf('deep',.2));const r=await router.route({prompt:'Investigate'},models);assert.equal(r.pick,'fast');assert.equal(r.retries,1);assert.deepEqual(calls.map(c=>c.body.model),['clef-flash','clef']);});
test('vision is enforced even for a bad semantic pick, caps swap to a ranked usable model',async()=>{const {router}=make({},async()=>cf('other'));assert.notEqual((await router.route({prompt:'Inspect image',screenshot:true},models)).pick,'other');const r=await router.route({prompt:'Debug'},models,{codex:{remaining:0}});assert.equal(r.pick,'other');});
test('screenshot uses regular Clef with JPEG copy, original attachment remains intact',async()=>{const {router,calls}=make();router.image=async()=> 'smallJPEG';const state={prompt:'Inspect screenshot',screenshot:true,attachments:['original.png']};await router.route(state,models);assert.equal(calls[0].body.model,'clef');assert.deepEqual(calls[0].body.images,[{content_type:'image/jpeg',base64:'smallJPEG'}]);assert.deepEqual(state.attachments,['original.png']);});
test('each continuity trigger and target window 80% check',()=>{const c=config();const s={prompt:'a'.repeat(400),context_tokens:7900,previous:deep};assert.equal(continuity(s,fast,{continuation:true},c).reason,'target context threshold');assert.equal(continuity(s,deep,{continuation:true},c).action,'continue');assert.equal(continuity(s,other,{},c).reason,'provider changed');assert.equal(continuity({...s,new_chat:true},deep,{},c).reason,'user requested');assert.equal(continuity(s,deep,{continuation:false},c).reason,'unrelated task');assert.equal(continuity(s,deep,{},config({session_mode:'always_new'})).reason,'always new');});
test('same-provider hysteresis avoids insignificant switches; caps permit switching',async()=>{const {router}=make({hysteresis:.3},async()=>cf('deep'));const near={...fast,complexity:.7};assert.equal((await router.route({prompt:'Debug',previous:near},[near,deep])).pick,'fast');assert.equal((await router.route({prompt:'Debug',previous:near},[near,deep],{codex:{remaining:0}})).exhausted,true);});
test('shadow retains manual pick and logs recommendation plus override feedback',async()=>{const {router,logs}=make({router_mode:'shadow'});const r=await router.route({prompt:'Debug',manual_pick:'fast'},models);assert.equal(r.pick,'fast');assert.equal(r.router_pick,'deep');assert.equal(logs[0].override,true);});
test('configuration rejects invalid data; deterministic cannot be disabled; import drops secrets',()=>{assert.deepEqual(config({tiers:[]}).tiers,['deterministic']);for(const bad of [{confidence:2},{summary_start:.9},{router_mode:'bad'},{image_bytes:200000},{models:{fast:{context:10}}},{never_send:'private'},{timeout_ms:6000}])assert.throws(()=>config(bad));assert.ok(!JSON.stringify(config({apiKey:'secret'})).includes('secret'));});
test('budgets reserve before calls, and cap checks include the weekly window',async()=>{const {router,calls}=make({cloudflare_neurons:1,groq_rpd:1});await router.route({prompt:'Rename'},models);await router.route({prompt:'Rename'},models);assert.equal(calls.length,1);const r=await router.route({prompt:'Debug'},models,{codex:{remaining:99,secondary:{remaining:0}}});assert.equal(r.pick,'other');});
test('Groq destination is only available for simple text after all CLI quotas are capped',async()=>{const {router}=make({groq_destination:true,tiers:['deterministic']});const q={codex:{remaining:0},claude:{remaining:0}};assert.equal((await router.route({prompt:'Translate this brief note'},models,q)).pick,GROQ_MODEL.id);assert.equal((await router.route({prompt:'Debug architecture'},models,q)).exhausted,true);assert.equal((await router.route({prompt:'Translate',screenshot:true},models,q)).exhausted,true);});
test('redaction handles private keys, common tokens, passwords, and credential URLs',()=>{const r=redact('password="hidden" sk-123456789012 https://user:pass@example.com -----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----');for(const s of ['hidden','123456789012','user:pass','abc'])assert.ok(!r.includes(s));});

test('invalid retry confidence or complexity falls through to Groq',async()=>{
  for(const bad of [{confidence:2},{confidence:-1},{complexity:6}]) {
    let cfCalls=0;
    const {router}=make({},async url=>{
      if(!url.includes('cloudflare'))return groq();
      const response=cf('deep',++cfCalls===1?.2:.9);
      if(cfCalls===2){const read=response.json;response.json=async()=>{const data=await read();if(bad.confidence!=null)data.result.answers.pick.confidence=bad.confidence;if(bad.complexity!=null)data.result.answers.complexity.score=bad.complexity;return data;};}
      return response;
    });
    const r=await router.route({prompt:'Investigate'},models);
    assert.equal(r.tier,'groq');assert.equal(r.pick,'fast');assert.equal(cfCalls,2);
  }
});

test('healthy quotas are preferred, low quotas remain usable and manual picks stay explicit',async()=>{
  const {router}=make({tiers:['deterministic']});
  const q={codex:{remaining:10},claude:{remaining:100}};
  assert.equal((await router.route({prompt:'Debug'},models,q)).pick,'other');
  assert.equal((await router.route({prompt:'Debug',manual_pick:'deep'},models,q)).pick,'deep');
  assert.equal((await router.route({prompt:'Debug'},models,{codex:{remaining:10},claude:{remaining:5}})).pick,'deep');
});

test('brand quota never bypasses an exhausted provider window',async()=>{
  const {router}=make({tiers:['deterministic']});
  const opus={...other,brand:'opus'};
  assert.equal((await router.route({prompt:'Debug'},[opus],{claude:{remaining:0},opus:{remaining:100}})).exhausted,true);
});

test('Groq decisions require real booleans for continuity and capability checks',async()=>{
  const {router}=make({primary:'groq'},async()=>({ok:true,status:200,json:async()=>({choices:[{message:{content:JSON.stringify({pick:'fast',confidence:.9,complexity:.2,needs_vision:false,needs_long_context:false,continuation:'false'})}}]})}));
  assert.equal((await router.route({prompt:'Debug'},models)).tier,'deterministic');
});

test('manual Sonnet with unknown vision metadata stays selected for screenshots in every routing mode',async()=>{
  const sonnet={id:'claude-sonnet-5-5-high',agent:'claude',effort:'high',label:'Claude Sonnet 5.5 High'};
  for(const router_mode of ['manual','shadow','auto']) {
    const {router,calls,logs}=make({router_mode});
    const r=await router.route({prompt:'Investigate this screenshot',manual_pick:sonnet.id,screenshot:true,previous:deep},[...models,sonnet]);
    assert.equal(r.pick,sonnet.id);
    assert.equal(r.manual_pick,sonnet.id);
    assert.equal(r.reason,'provider changed');
    assert.equal(logs[0].manual_pick,sonnet.id);
    if(router_mode!=='shadow')assert.equal(calls.length,0,'manual sends do not invoke an external classifier');
  }
});

test('an incompatible, capped, disabled or missing manual pick fails instead of dispatching another model',async()=>{
  const cases=[
    [{manual_pick:'other',screenshot:true},{},{},/does not support images/],
    [{manual_pick:'deep'},{codex:{remaining:0}},{},/out of usage/],
    [{manual_pick:'deep'},{codex:{remaining:90,secondary:{remaining:0}}},{},/out of usage/],
    [{manual_pick:'deep'},{},{models:{deep:{enabled:false}}},/disabled/],
    [{manual_pick:'missing'},{},{},/unavailable/],
    [{manual_pick:'fast',required_context_tokens:15000},{},{},/insufficient context/],
  ];
  for(const [state,quotas,settings,message] of cases){
    const {router,calls}=make(settings);
    await assert.rejects(router.route({prompt:'Task',...state},models,quotas),message);
    assert.equal(calls.length,0);
  }
});

test('shadow classification cannot override a manual pick with inferred vision or context requirements',async()=>{
  const {router}=make({router_mode:'shadow'},async()=>{
    const response=cf('deep');const read=response.json;
    response.json=async()=>{const data=await read();data.result.answers.needs_long_context.noul=1;return data;};
    return response;
  });
  assert.equal((await router.route({prompt:'Task',manual_pick:'fast'},models)).pick,'fast');
});
