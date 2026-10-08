'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {Router,config}=require('../lib/routing');
const {configFile,migrate}=require('../lib/routing-config');

test('config file supports external edits, restart, invalid edit recovery and UI saves',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'router-config-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store=configFile(dir,{confidence:.4});
  const changed={...store.read(),confidence:.2};
  fs.writeFileSync(store.file,JSON.stringify(changed));
  assert.equal(store.read().confidence,.2);
  assert.equal(configFile(dir,{}).read().confidence,.2);
  fs.writeFileSync(store.file,'broken JSON');
  assert.equal(store.read().confidence,.2);assert.match(store.error,/last valid/);
  fs.writeFileSync(store.file,JSON.stringify({...changed,confidence:4}));
  assert.equal(store.read().confidence,.2);assert.match(store.error,/confidence/);
  store.save({...changed,confidence:.3});assert.equal(store.error,'');
  assert.equal(JSON.parse(fs.readFileSync(store.file)).confidence,.3);
  assert.throws(()=>store.save({...changed,policy:{probability_margin:2}}),/probability_margin/);
  assert.equal(JSON.parse(fs.readFileSync(store.file)).confidence,.3);
});

test('legacy preferences migrate once and configured empty assignments stay empty',()=>{
  const old=migrate({models:{'claude-sonnet-5-5-high':{description:'Custom'}}});
  assert.deepEqual(old.models['claude-sonnet-5-5-high'].tasks,['visual']);
  assert.equal(old.models['claude-sonnet-5-5-high'].description,'Custom');
  const changed=config({...old,models:{future:{tasks:[]}}});
  assert.deepEqual(migrate(changed).models,{future:{tasks:[]}});
});

test('custom profiles route renamed future models and changing fallback order changes decisions',async()=>{
  const models=[{id:'future-a',agent:'new-provider',context:20000,complexity:.5},{id:'future-b',agent:'another',context:20000,complexity:.9}];
  let settings=config({primary:'deterministic',task_profiles:{books:{label:'Book work',keywords:['novel'],exclude_keywords:['invoice'],priority:1,complexity:.9}},models:{'future-a':{tasks:['books']}}});
  const router=new Router({getConfig:()=>settings});
  assert.equal((await router.route({prompt:'Edit my novel'},models)).pick,'future-a');
  settings=config({...settings,fallback_order:['capacity','profiles']});
  assert.equal((await router.route({prompt:'Edit my novel'},models)).pick,'future-b');
  settings=config({...settings,fallback_order:['profiles','capacity'],models:{'future-a':{tasks:['books'],avoid_tasks:['books']}}});
  const result=await router.route({prompt:'Edit my novel'},models);
  assert.equal(result.pick,'future-b');assert.equal(result.excluded_models['future-a'],'excluded task profile');
});

test('provider weights and margins work for arbitrary provider names',async()=>{
  const models=[{id:'a',agent:'one',context:10000,complexity:.5},{id:'b',agent:'two',context:10000,complexity:.5}];
  const router=new Router({getConfig:()=>({primary:'deterministic',provider_weights:{one:2,two:1}})});
  for(let i=0;i<30;i++){const decision=await router.route({prompt:'Task'},models);router.recordDestination(models.find(m=>m.id===decision.pick).agent);}
  assert.deepEqual(router.usage().destination_turns,{one:20,two:10});
});

test('custom prompts, context defaults and bounded input reach the classifier',async()=>{
  let request;
  const settings=config({router_mode:'auto',retry:false,prompts:{choice:'Choose using my custom preferences.'},policy:{default_context:9000,prompt_chars:300,prompt_head:100,recent_chars:20,recent_messages:1}});
  const router=new Router({getConfig:()=>settings,secrets:{get:async()=>''}});
  router.call=async(_tier,payload)=>{request=payload;return {pick:'future',confidence:.8,complexity:.5,needs_vision:false,needs_long_context:false,continuation:true};};
  await router.route({prompt:'x'.repeat(500),recent_work:[{text:'first'},{text:'y'.repeat(50)}]},[{id:'future',agent:'one'}]);
  assert.equal(request.questions.pick.instructions,'Choose using my custom preferences.');
  assert.ok(request.state.latest_request.length<=300);assert.equal(request.state.recent_work.length,1);assert.equal(request.state.recent_work[0].text.length,20);
  assert.match(request.questions.pick.criteria.future,/context 9000/);
});
