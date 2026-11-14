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

test('feedback task purposes guide low-confidence fallback without treating screenshots as visual design',async()=>{
  const personal=[{...deep,id:'gpt-6.1-sol-medium',tasks:['backend']}, {...other,id:'claude-sonnet-5-5-high',vision:true,tasks:['visual']}, {...other,id:'claude-opus-5-5-medium',vision:true,tasks:['build']}, {...fast,id:'gemini-3.8-flash-high',agent:'gemini',tasks:['information']}];
  for(const [prompt,expected] of [['Debug why my selected model was not used','gpt-6.1-sol-medium'],['Implement phase 2 with supergroup forum topics in the backend','gpt-6.1-sol-medium'],['Make the layout more beautiful','claude-sonnet-5-5-high'],['Build a new app from scratch','claude-opus-5-5-medium'],['Search documentation and organize a plan','gemini-3.8-flash-high']]) {
    const {router}=make();router.call=async()=>({pick:personal[1].id,confidence:.2,complexity:.5,needs_vision:false,needs_long_context:false,continuation:true});router.image=async()=>'JPEG';
    const r=await router.route({prompt,screenshot:true,previous:personal[2]},personal);
    assert.equal(r.pick,expected);assert.equal(r.confidence,.2);assert.equal(r.used_default,true);
  }
});
test('eligibility diagnostics explain quotas and manual-only models',async()=>{
  const {router}=make({tiers:['deterministic'],models:{deep:{auto_enabled:false}}});
  const r=await router.route({prompt:'Task'},models,{claude:{remaining:0}});
  assert.deepEqual(r.eligible_models,['fast']);assert.equal(r.excluded_models.deep,'manual only');assert.equal(r.excluded_models.other,'quota exhausted');
});
test('Visor routing inspects actual quoted requests instead of review boilerplate',async()=>{
  const {router,calls}=make();
  await router.route({prompt:'Visor client review: site review. Match the local project before editing.\n<client-comment>Make the heading and icons beautiful</client-comment>\nOwner instruction: Apply the visual changes'},models);
  assert.match(calls[0].body.state.latest_request,/heading and icons/);assert.doesNotMatch(calls[0].body.state.latest_request,/Match the local project/);assert.equal(calls[0].body.state.task_hint,'visual');
});
test('Clef choice focuses on task fit and omits invented numerical capacity from descriptions',async()=>{
  const {router,calls}=make();await router.route({prompt:'Debug selected model'},models);
  const pick=calls[0].body.questions.pick;
  assert.match(pick.instructions,/not model names mentioned/);
  assert.match(pick.instructions,/Ignore provider shares/);
  assert.doesNotMatch(Object.values(pick.criteria).join(' '),/capacity/);
});
test('provider balance only changes an accepted proposal among close probability options',async()=>{
  const {router}=make();router.recordDestination('codex');
  const decision={pick:'fast',confidence:.9,complexity:.5,needs_vision:false,needs_long_context:false,continuation:true};
  router.call=async()=>({...decision,probabilities:{fast:.52,other:.48}});
  const close=await router.route({prompt:'Task'},models);assert.equal(close.pick,'other');assert.equal(close.semantic_pick,'fast');
  router.call=async()=>({...decision,probabilities:{fast:.9,other:.1}});
  assert.equal((await router.route({prompt:'Task'},models)).pick,'fast');
});

test('screenshot failures retain useful diagnostics without leaking provider messages',async()=>{
  for(const [error,reason] of [
    [Object.assign(new Error('This operation was aborted'),{name:'AbortError'}),'request timed out'],
    [new Error('503: token=test-secret-value'),'provider HTTP 503'],
    [new SyntaxError('bad provider content test-secret-value'),'invalid provider JSON'],
    [new Error('fetch failed'),'network request failed'],
  ]){
    const {router,logs}=make({tiers:['cloudflare','deterministic']},async()=>{throw error;});
    router.image=async()=>'smallJPEG';
    const result=await router.route({prompt:'Inspect image',screenshot:true},models);
    assert.equal(result.attempts[0].reason,reason);
    assert.ok(!JSON.stringify(logs).includes('test-secret-value'));
  }
  const {router}=make({tiers:['cloudflare','deterministic']});
  router.image=async()=>null;
  assert.equal((await router.route({prompt:'Inspect image',screenshot:true},models)).attempts[0].reason,'Screenshot copy unavailable');
});

test('model overrides preserve editable descriptions and assignments without injecting IDs',()=>{
  const c=config({models:{arbitrary:{description:'My new model',vision:true,tasks:['visual'],avoid_tasks:['backend']}}});
  assert.deepEqual(Object.keys(c.models),['arbitrary']);assert.equal(c.models.arbitrary.description,'My new model');assert.deepEqual(c.models.arbitrary.tasks,['visual']);
  assert.throws(()=>config({models:{arbitrary:{tasks:['missing']}}}),/Unknown task/);
});

test('balanced local routing distributes equal-fit tasks by provider rather than model count', async () => {
  const {router}=make({tiers:['deterministic']});
  const equal=[{...fast,id:'codex',agent:'codex'},{...fast,id:'claude-1',agent:'claude'},{...fast,id:'claude-2',agent:'claude'},{...fast,id:'gemini',agent:'gemini'}];
  for(let i=0;i<30;i++) {
    const result=await router.route({prompt:'Simple edit'},equal);
    router.recordDestination(equal.find(m=>m.id===result.pick).agent);
  }
  assert.deepEqual(router.usage().destination_turns,{codex:10,claude:10,gemini:10});
});

test('balance respects manual choices, exhausted quotas, explicit defaults and disabling the preference', async () => {
  const equal=[{...fast,id:'codex',agent:'codex'},{...fast,id:'claude',agent:'claude'}];
  const {router}=make({tiers:['deterministic']});
  for(let i=0;i<5;i++) router.recordDestination('codex');
  assert.equal((await router.route({prompt:'Simple edit'},equal)).pick,'claude');
  assert.equal((await router.route({prompt:'Simple edit',manual_pick:'codex'},equal)).pick,'codex');
  assert.equal((await router.route({prompt:'Simple edit'},equal,{claude:{remaining:0}})).pick,'codex');
  const disabled=make({tiers:['deterministic'],balance_providers:false}).router;
  disabled.recordDestination('codex');
  assert.equal((await disabled.route({prompt:'Simple edit'},equal)).pick,'codex');
  const configured=make({default_model:'fast'},async()=>cf('deep',.2)).router;
  configured.recordDestination('codex');
  assert.equal((await configured.route({prompt:'Investigate'},models)).pick,'fast');
  assert.throws(()=>config({balance_providers:'yes'}),/Invalid balance_providers/);
});

test('classification receives provider shares but decisions and benchmarks never increment task counters', async () => {
  const {router,calls}=make();
  router.recordDestination('codex');router.recordDestination('codex');router.recordDestination('claude');
  await router.route({prompt:'Debug',benchmark:true},models);
  assert.deepEqual(calls[0].body.state.provider_usage,{codex:{turns:2,share:2/3,target:.5},claude:{turns:1,share:1/3,target:.5}});
  assert.deepEqual(router.usage().destination_turns,{codex:2,claude:1});
  assert.equal((await router.route({prompt:'Debug'},models)).pick,'deep','an accepted semantic choice stays authoritative');
  assert.deepEqual(router.usage().destination_turns,{codex:2,claude:1});
});

test('provider dispatch counts persist across instances and reset at the UTC day boundary', () => {
  let stored={},time=Date.parse('2026-10-04T12:00:00Z');
  const options={now:()=>time,store:{get:()=>stored,set:u=>stored=u}};
  new Router(options).recordDestination('claude');
  const next=new Router(options);
  assert.equal(next.usage().destination_turns.claude,1);
  time+=86400000;
  assert.deepEqual(next.usage().destination_turns,{});
});

test('Sol High is excluded from Auto but remains available for manual selection',async()=>{
  const high={id:'gpt-6.1-sol-high',model:'gpt-6.1-sol',agent:'codex',effort:'high',vision:true};
  const medium={...high,id:'gpt-6.1-sol-medium',effort:'medium'};
  const {router}=make({tiers:['deterministic'],models:{[high.id]:{auto_enabled:false}}});
  assert.equal((await router.route({prompt:'Debug backend'},[medium,high])).pick,medium.id);
  assert.equal((await router.route({prompt:'Debug backend',manual_pick:high.id},[medium,high])).pick,high.id);
  const enabled=make({tiers:['deterministic'],models:{[high.id]:{auto_enabled:true}}}).router;
  assert.equal((await enabled.route({prompt:'Debug backend'},[high])).pick,high.id);
});

test('routing preserves the latest request and redacts recent work while differentiating reasoning choices',async()=>{
  const {router,calls}=make();
  await router.route({prompt:'old context '.repeat(900)+'LATEST REQUEST: inspect keyboard focus',project:'p',project_name:'Editor',stack:'React, TypeScript',language:'English',recent_work:[{role:'assistant',text:'token=test-secret-value worked on focus'}],previous:fast},models);
  const state=calls[0].body.state;
  assert.ok(state.latest_request.endsWith('LATEST REQUEST: inspect keyboard focus'));assert.ok(state.latest_request.length<=6000);
  assert.equal(state.stack,'React, TypeScript');assert.equal(state.project_name,'Editor');assert.equal(state.previous_model,'fast');
  assert.ok(!JSON.stringify(state).includes('test-secret-value'));
  assert.match(calls[0].body.questions.pick.criteria.fast,/Reasoning: low/);
  assert.match(calls[0].body.questions.pick.criteria.deep,/Reasoning: high/);
});

test('low-confidence results preserve Clef proposal and probabilities separately from the default',async()=>{
  const {router}=make({default_model:'fast'},async()=>cf('deep',.2));
  const r=await router.route({prompt:'Investigate'},models);
  assert.equal(r.pick,'fast');assert.equal(r.semantic_pick,'deep');assert.equal(r.used_default,true);assert.equal(r.candidate_probabilities.deep,.2);
});

test('Clef and Groq receive a separate current request and redacted prior-task background', async () => {
  const prompt = 'Restyle the existing page. Keep backend behavior unchanged.';
  for (const primary of ['cloudflare', 'groq']) {
    const { router, calls } = make({ primary }, async () => primary === 'cloudflare' ? cf() : groq());
    await router.route({ prompt, recent_work: [{ role: 'user', text: 'Earlier: debug the security architecture token=test-secret-value' }] }, models);
    const state = primary === 'cloudflare' ? calls[0].body.state : JSON.parse(calls[0].body.messages[1].content).state;
    assert.equal(state.latest_request, prompt);
    assert.ok(!Object.hasOwn(state, 'prompt'));
    assert.match(state.recent_work[0].text, /Earlier: debug the security architecture/);
    assert.ok(!JSON.stringify(calls).includes('test-secret-value'));
  }
  assert.equal(config().confidence, .4);
});

test('calibrated gate accepts 40 percent and retains fallback below it without changing reported confidence',async()=>{
  for(const [confidence,accepted] of [[.4,true],[.3999,false]]) {
    const {router,calls}=make({},async()=>cf('deep',confidence));
    const result=await router.route({prompt:'Task'},models);
    assert.equal(result.used_default,!accepted);assert.equal(result.confidence,confidence);
    assert.equal(calls.length,accepted?1:2);
  }
});
test('first Clef response remains observable when retry changes the proposal',async()=>{
  let count=0;const {router}=make({},async()=>++count===1?cf('fast',.2):cf('deep',.6));
  const r=await router.route({prompt:'Task'},models);
  assert.equal(r.initial_decision.pick,'fast');assert.equal(r.initial_decision.confidence,.2);
  assert.equal(r.semantic_pick,'deep');assert.equal(r.confidence,.6);assert.equal(r.retries,1);
});
test('runtime migrates the old default once, preserving custom and subsequent thresholds',()=>{
  const {runtime}=require('../lib/routing-runtime');
  for(const [saved,calibrated,expected] of [[.65,false,.4],[.55,false,.55],[.65,true,.65]]) {
    const values={routingConfig:{confidence:saved},routingConfidenceCalibrated:calibrated};
    const context={globalState:{get:(key,fallback)=>values[key]??fallback,update:(key,value)=>{values[key]=value;return Promise.resolve();}},secrets:{get:async()=>''}};
    const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'routing-runtime-'));
    try{assert.equal(runtime(context,()=>[],dir).getConfig().confidence,expected);}finally{fs.rmSync(dir,{recursive:true,force:true});}
  }
});

test('runtime exposes prepareSummary and compactSource', () => {
  const { runtime, compactSource } = require('../lib/routing-runtime');
  const values = { routingConfig: { confidence: .4 } };
  const context = { globalState: { get: (key, fallback) => values[key] ?? fallback, update: (key, value) => { values[key] = value; return Promise.resolve(); } }, secrets: { get: async () => '' } };
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-runtime-'));
  try {
    const rt = runtime(context, () => [], dir);
    assert.equal(typeof rt.prepareSummary, 'function');
    assert.equal(typeof compactSource, 'function');
    const chat = { messages: [{ role: 'user', text: 'Hello' }, { role: 'assistant', text: 'World' }] };
    assert.match(compactSource(chat), /Hello/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('real runtime saves, resets and reloads routing settings', async t => {
  const { runtime } = require('../lib/routing-runtime');
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-runtime-reset-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const values = {};
  const context = { globalState: {
    get: (key, fallback) => values[key] ?? fallback,
    update: async (key, value) => { values[key] = value; },
  }, secrets: { get: async () => '' } };
  const rt = runtime(context, () => [], dir);
  await rt.handle({ type: 'routingSave', config: { ...rt.getConfig(), confidence: .2 } });
  assert.equal(rt.getConfig().confidence, .2);
  await rt.handle({ type: 'routingReset' });
  assert.equal(rt.getConfig().confidence, config({}).confidence);
  assert.equal(runtime(context, () => [], dir).getConfig().confidence, config({}).confidence);
  assert.equal((await rt.snapshot()).configError, '');
});

test('Clef reserves token-based Neurons and reconciles reported input usage',async()=>{
  const {router}=make({},async()=>{const response=cf();const read=response.json;response.json=async()=>{const data=await read();data.result.usage={input_tokens:1000};return data;};return response;});
  await router.route({prompt:'Debug'},models);
  assert.ok(Math.abs(router.usage().neurons-3.455)<.001);
});

test('ten screenshot decisions fit the daily budget without flat image fees',async()=>{
  const {router,calls}=make();router.image=async()=>'copy';
  for(let i=0;i<10;i++)assert.equal((await router.route({prompt:'Inspect',screenshot:true},models)).tier,'cloudflare');
  assert.equal(calls.length,10);assert.ok(router.usage().neurons<2000);
});

test('free-tier ceilings migrate old Groq settings and reject larger budgets',()=>{
  for(const groq_tpm of [8001,12000,18000]) assert.equal(config({groq_tpm}).groq_tpm,8000);
  assert.equal(config({groq_tpm:4000}).groq_tpm,4000);
  for(const settings of [{groq_tpm:18001},{groq_tpm:Infinity},{cloudflare_neurons:10001},{groq_tpd:200001}]) assert.throws(()=>config(settings),/Invalid/);
});

test('Clef uses current rates, preserves spent budget and refuses calls above the remaining allowance',async()=>{
  const {router,calls}=make({},async()=>({ok:true,status:200,json:async()=>({result:{answers:{},usage:{input_tokens:1000}}})}));
  router.usage().neurons=9000;
  await router.callTier('cloudflare',{state:'Backend task',questions:{}},true);
  assert.ok(Math.abs(router.usage().neurons-9021.818)<.001);
  const before=router.usage().neurons;
  await router.callTier('cloudflare',{state:'Frontend task',questions:{}});
  assert.ok(Math.abs(router.usage().neurons-before-3.455)<.001);
  router.usage().neurons=9999;
  await assert.rejects(router.callTier('cloudflare',{state:'x'.repeat(3000),questions:{}}),/budget exhausted/);
  assert.equal(calls.length,2,'no request is sent after budget exhaustion');
});

const decision=JSON.stringify({pick:'fast',confidence:.9,complexity:.2,needs_vision:false,needs_long_context:false,continuation:true});
const cfChat=(content=decision,usage={prompt_tokens:100,completion_tokens:50})=>({ok:true,status:200,json:async()=>({choices:[{message:{content}}],usage})});
const isChat=url=>url.includes('/ai/v1/chat/completions');
test('past the spill share Groq work goes to Cloudflare GPT OSS 120B, paid in Neurons rather than Groq tokens',async()=>{
  const fenced=['```json',decision,'```'].join(String.fromCharCode(10));
  const {router,calls}=make({primary:'groq',tiers:['groq','deterministic'],groq_tpd:10000,groq_spill:.8},async url=>isChat(url)?cfChat(fenced):groq());
  router.usage().groq_tokens=7000;
  assert.equal(router.groqNearLimit(),false);
  assert.equal((await router.route({prompt:'Rename'},models)).tier,'groq');
  assert.match(calls[0].url,/api\.groq\.com/);
  router.usage().groq_tokens=8500;
  assert.equal(router.groqNearLimit(),true);
  const before=router.usage().groq_requests;
  const r=await router.route({prompt:'Rename'},models);
  assert.equal(r.pick,'fast');assert.equal(r.tier,'groq');
  assert.equal(calls[1].url,'https://api.cloudflare.com/client/v4/accounts/'+'a'.repeat(32)+'/ai/v1/chat/completions');
  assert.equal(calls[1].body.model,'@cf/openai/gpt-oss-120b');
  assert.equal(router.usage().groq_requests,before);assert.equal(router.usage().groq_tokens,8500);
  assert.ok(Math.abs(router.usage().neurons-(100*.031818+50*.068182))<.001);
});
test('Cloudflare backs Groq up when Groq refuses, and Groq is then skipped for the minute',async()=>{
  const {router,calls}=make({primary:'groq',tiers:['groq','deterministic']},async url=>isChat(url)?cfChat():{ok:false,status:429,json:async()=>({error:{message:'tokens per day'}})});
  const r=await router.route({prompt:'Rename'},models);
  assert.equal(r.pick,'fast');assert.deepEqual(calls.map(c=>isChat(c.url)),[false,true]);
  await router.route({prompt:'Rename'},models);
  assert.equal(calls.filter(c=>!isChat(c.url)).length,1);
});
test('a failing Cloudflare leaves the Groq answer or error intact and never loops',async()=>{
  const {router,calls}=make({primary:'groq',tiers:['groq','deterministic']},async url=>isChat(url)?{ok:false,status:500,json:async()=>({})}:{ok:false,status:500,json:async()=>({error:{message:'groq down'}})});
  const r=await router.route({prompt:'Rename'},models);
  assert.equal(r.tier,'deterministic');assert.equal(r.attempts[0].status,'fallback');
  assert.equal(calls.length,2);
});

test('Cloudflare chat reserves the maximum output before sending and resets its budget at UTC midnight',async()=>{
  const {router,calls}=make({cloudflare_neurons:100},async()=>cfChat());
  await assert.rejects(router.callTier('cloudflare-chat',{messages:[{role:'user',content:'Hello'}]}),/budget exhausted/);
  assert.equal(calls.length,0);
  const day=Date.UTC(2026,9,5,23,59);
  router.now=()=>day;
  router.usage().neurons=99;
  router.now=()=>day+120000;
  assert.equal(router.usage().neurons,0);
});

test('Cloudflare keeps the simple text destination available after Groq daily requests are spent',async()=>{
  const {router}=make({groq_destination:true,tiers:['deterministic']});
  router.usage().groq_requests=1000;
  const result=await router.route({prompt:'Search documentation'},models,{codex:{remaining:0},claude:{remaining:0},gemini:{remaining:0}});
  assert.equal(result.pick,'groq:gpt-oss-120b');
});
test('saved OpenRouter settings migrate away and the spill share is validated',()=>{
  const c=config({tiers:['openrouter','groq'],primary:'openrouter'});
  assert.deepEqual(c.tiers,['cloudflare','groq','deterministic']);
  assert.equal(c.primary,'cloudflare');
  assert.throws(()=>config({tiers:['nope']}),/Invalid tiers/);
  assert.throws(()=>config({groq_spill:2}),/Invalid groq_spill/);
  assert.equal(config({}).groq_spill,.8);
});
test('tokens Groq reports for dictation and titles count toward the router day',()=>{
  const {router}=make();
  router.recordGroqTokens(1200);router.recordGroqTokens(NaN);router.recordGroqTokens(0);
  assert.equal(router.usage().groq_tokens,1200);assert.equal(router.usage().groq_requests,1);
});
test('Groq replaces reservations with actual tokens in daily and minute counters',async()=>{
  const {router}=make({primary:'groq'},async()=>{const response=groq();const read=response.json;response.json=async()=>({...await read(),usage:{total_tokens:100}});return response;});
  await router.route({prompt:'Rename'},models);await router.route({prompt:'Rename'},models);
  assert.equal(router.usage().groq_tokens,200);assert.deepEqual(router.usage().minutes.map(m=>m.tokens),[100,100]);
});

test('old estimates migrate once without clearing provider blocks or request counts',()=>{
  const day=new Date().toISOString().slice(0,10);
  const router=new Router({store:{get:()=>({day,neurons:10000,groq_tokens:73044,groq_requests:27,cf_blocked:true,minutes:[]}),set:()=>{}}});
  const u=router.usage();assert.equal(u.neurons,0);assert.equal(u.groq_tokens,0);assert.equal(u.groq_requests,27);assert.equal(u.cf_blocked,true);assert.equal(u.legacy_estimates.neurons,10000);
  u.neurons=42;assert.equal(router.usage().neurons,42);
});

test('local budget failures are distinguished from provider quota failures',async()=>{
  const {router}=make({cloudflare_neurons:1});
  const r=await router.route({prompt:'Debug'},models);
  assert.equal(r.attempts[0].reason,'local budget exhausted');
});
test('Clef sends several typed questions, redacts credentials, and parses the published answer schema',async()=>{const {router,calls,logs}=make();const r=await router.route({prompt:'Debug architecture token=test-secret-value',project:'x'},models);assert.equal(r.tier,'cloudflare');assert.equal(r.pick,'deep');assert.equal(r.action,'continue');assert.equal(calls[0].body.model,'clef-flash');assert.equal(Object.keys(calls[0].body.questions).length,5);assert.ok(!JSON.stringify(calls).includes('test-secret-value'));assert.ok(!JSON.stringify(logs).includes('test-secret-value'));});
test('429 and 3036 fall to Groq; exhausted primary is skipped on subsequent calls',async()=>{for(const status of [429,400]){const {router,calls}=make({},async url=>url.includes('cloudflare')?{ok:false,status,json:async()=>({errors:[{code:3036,message:'allocation used'}]})}:groq());assert.equal((await router.route({prompt:'Rename field',project:'p'},models)).tier,'groq');assert.equal((await router.route({prompt:'Rename field',project:'p'},models)).tier,'groq');assert.equal(calls.filter(c=>c.url.includes('cloudflare')).length,1);}});
test('timeout or two unavailable services fall through without blocking',async()=>{const {router}=make({},async()=>{throw Error('timeout');});assert.equal((await router.route({prompt:'Fix a typo'},models)).tier,'deterministic');});
test('disabled tiers and private projects make no external requests',async()=>{for(const settings of [{tiers:['deterministic']},{never_send:['private']},{primary:'deterministic'}]){const {router,calls}=make(settings);assert.equal((await router.route({prompt:'Investigate',project:'private'},models)).tier,'deterministic');assert.equal(calls.length,0);}});
test('low confidence retries exactly once on regular Clef then uses configured default',async()=>{const {router,calls}=make({default_model:'fast'},async()=>cf('deep',.2));const r=await router.route({prompt:'Investigate'},models);assert.equal(r.pick,'fast');assert.equal(r.retries,1);assert.deepEqual(calls.map(c=>c.body.model),['clef-flash','clef']);});
test('vision is enforced even for a bad semantic pick, caps swap to a ranked usable model',async()=>{const {router}=make({},async()=>cf('other'));assert.notEqual((await router.route({prompt:'Inspect image',screenshot:true},models)).pick,'other');const r=await router.route({prompt:'Debug'},models,{codex:{remaining:0}});assert.equal(r.pick,'other');});
test('screenshot uses regular Clef with JPEG copy, original attachment remains intact',async()=>{const {router,calls}=make();router.image=async()=> 'smallJPEG';const state={prompt:'Inspect screenshot',screenshot:true,attachments:['original.png']};await router.route(state,models);assert.equal(calls[0].body.model,'clef');assert.deepEqual(calls[0].body.images,[{content_type:'image/jpeg',base64:'smallJPEG'}]);assert.deepEqual(state.attachments,['original.png']);});
test('each continuity trigger and target window 80% check',()=>{const c=config();const s={prompt:'a'.repeat(400),context_tokens:7900,previous:deep};assert.equal(continuity(s,fast,{continuation:true},c).reason,'target context threshold');assert.equal(continuity(s,deep,{continuation:true},c).action,'continue');assert.equal(continuity(s,other,{},c).reason,'provider changed');assert.equal(continuity({...s,new_chat:true},deep,{},c).reason,'user requested');assert.equal(continuity(s,deep,{continuation:false},c).reason,'unrelated task');assert.equal(continuity(s,deep,{},config({session_mode:'always_new'})).reason,'always new');});
test('same-provider hysteresis avoids insignificant switches; caps permit switching',async()=>{const {router}=make({hysteresis:.3},async()=>cf('deep'));const near={...fast,complexity:.7};assert.equal((await router.route({prompt:'Debug',previous:near},[near,deep])).pick,'fast');assert.equal((await router.route({prompt:'Debug',previous:near},[near,deep],{codex:{remaining:0}})).exhausted,true);});
test('legacy shadow settings migrate to manual without classifier calls; benchmarks still classify',async()=>{
  const {router,calls}=make({router_mode:'shadow'});
  assert.equal(config({router_mode:'shadow'}).router_mode,'manual');
  assert.equal((await router.route({prompt:'Debug',manual_pick:'fast'},models)).pick,'fast');
  assert.equal(calls.length,0);
  assert.equal((await router.route({prompt:'Debug',benchmark:true},models)).tier,'cloudflare');
  assert.equal(calls.length,1);
});
test('configuration rejects invalid data; deterministic cannot be disabled; import drops secrets',()=>{assert.deepEqual(config({tiers:[]}).tiers,['deterministic']);for(const bad of [{confidence:2},{summary_start:.9},{router_mode:'bad'},{image_bytes:200000},{models:{fast:{context:10}}},{never_send:'private'},{timeout_ms:6000}])assert.throws(()=>config(bad));assert.ok(!JSON.stringify(config({apiKey:'secret'})).includes('secret'));});
test('budgets reserve before calls, and cap checks include the weekly window',async()=>{const {router,calls}=make({tiers:['cloudflare','groq','deterministic'],cloudflare_neurons:1,groq_rpd:1});await router.route({prompt:'Rename'},models);await router.route({prompt:'Rename'},models);assert.equal(calls.length,1);const r=await router.route({prompt:'Debug'},models,{codex:{remaining:99,secondary:{remaining:0}}});assert.equal(r.pick,'other');});
test('Groq destination is only available for simple text after all CLI quotas are capped',async()=>{const {router}=make({groq_destination:true,tiers:['deterministic']});const q={codex:{remaining:0},claude:{remaining:0}};assert.equal((await router.route({prompt:'Translate this brief note'},models,q)).pick,GROQ_MODEL.id);assert.equal((await router.route({prompt:'Debug architecture'},models,q)).exhausted,true);assert.equal((await router.route({prompt:'Translate',screenshot:true},models,q)).exhausted,true);});
test('redaction handles private keys, common tokens, passwords, and credential URLs',()=>{const r=redact('password="hidden" sk-123456789012 https://user:pass@example.com -----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----');for(const s of ['hidden','123456789012','user:pass','abc'])assert.ok(!r.includes(s));});
test('document tasks cannot fall back to the Groq destination without file tools',async()=>{
  const {router}=make({groq_destination:true,tiers:['deterministic']});
  assert.equal((await router.route({prompt:'Read my brief feedback',attachments:['feedback.json']},models,{codex:{remaining:0},claude:{remaining:0}})).exhausted,true);
});

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
  for(const router_mode of ['manual','auto']) {
    const {router,calls,logs}=make({router_mode});
    const r=await router.route({prompt:'Investigate this screenshot',manual_pick:sonnet.id,screenshot:true,previous:deep},[...models,sonnet]);
    assert.equal(r.pick,sonnet.id);
    assert.equal(r.manual_pick,sonnet.id);
    assert.equal(r.reason,'provider changed');
    assert.equal(logs[0].manual_pick,sonnet.id);
    assert.equal(calls.length,0,'manual sends do not invoke an external classifier');
  }
});

test('Claude, Gemini and Codex with missing metadata remain screenshot candidates and keep original attachments',async()=>{
  const imageModels=[
    {id:'claude-opus-5-5-medium',model:'claude-opus-5-5',agent:'claude'},
    {id:'claude-sonnet-5-5-high',model:'claude-sonnet-5-5',agent:'claude'},
    {id:'gemini-3.8-flash-high',model:'gemini-3.8-flash-high',agent:'gemini'},
    {id:'gpt-6.1-sol-medium',model:'gpt-6.1-sol',agent:'codex'},
  ];
  for(const target of imageModels){
    const {router,calls}=make({},async()=>cf(target.id));router.image=async()=>'routing-only-JPEG';
    const attachments=['original screenshot.png'];
    const r=await router.route({prompt:'Inspect screenshot',screenshot:true,attachments},imageModels);
    assert.equal(r.pick,target.id);
    assert.deepEqual(Object.keys(calls[0].body.questions.pick.criteria),imageModels.map(m=>m.id));
    assert.ok(Object.values(calls[0].body.questions.pick.criteria).every(v=>v.includes('vision true')));
    assert.deepEqual(attachments,['original screenshot.png']);
  }
});

test('explicit no-vision overrides and unknown text models stay excluded',async()=>{
  const {router,calls}=make({models:{'claude-sonnet-5-5-high':{vision:false}}});
  const r=await router.route({prompt:'Inspect screenshot',screenshot:true},[
    {id:'claude-sonnet-5-5-high',model:'claude-sonnet-5-5',agent:'claude'},
    {id:'gpt-oss-120b',model:'gpt-oss-120b',agent:'gemini'},
  ]);
  assert.equal(r.exhausted,true);assert.equal(calls.length,0);
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

test('manual selections skip classifier-inferred vision or context requirements',async()=>{
  const {router,calls}=make({router_mode:'auto'},async()=>{
    const response=cf('deep');const read=response.json;
    response.json=async()=>{const data=await read();data.result.answers.needs_long_context.noul=1;return data;};
    return response;
  });
  assert.equal((await router.route({prompt:'Task',manual_pick:'fast'},models)).pick,'fast');
  assert.equal(calls.length,0);
});
