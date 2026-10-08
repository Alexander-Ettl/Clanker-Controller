'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {config}=require('./routing');

// Legacy assignments are migration data only. Runtime decisions never inspect model IDs.
function migrate(input={}) {
  if(input.task_profiles||!Object.keys(input).length)return input;
  const assignments={'gpt-6.1-sol-medium':'backend','claude-sonnet-5-5-high':'visual','claude-opus-5-5-medium':'build','gemini-3.8-flash-high':'information'};
  const models={...input.models};
  for(const [id,task] of Object.entries(assignments))models[id]={...models[id],tasks:models[id]?.tasks||[task]};
  models['gpt-6.1-sol-high']={auto_enabled:false,...models['gpt-6.1-sol-high']};
  return {...input,models};
}
function configFile(dir,initial,onSave=()=>{}) {
  const file=path.join(dir,'routing-config.json');
  let current=config(migrate(initial)),error='';
  function save(value) {
    const next=config(value);
    fs.mkdirSync(dir,{recursive:true});
    const temporary=file+'.tmp';
    fs.writeFileSync(temporary,JSON.stringify(next,null,2)+'\n');
    fs.renameSync(temporary,file);
    current=next;error='';onSave(next);return next;
  }
  if(!fs.existsSync(file))save(current);
  return {file,save,get error(){return error;},read(){
    try {
      const input=JSON.parse(fs.readFileSync(file,'utf8'));
      for(const key of Object.keys(input))if(!Object.hasOwn(current,key))throw Error(`Unknown routing setting: ${key}`);
      const next=config(input);
      if(JSON.stringify(next)!==JSON.stringify(current))onSave(next);
      current=next;error='';
    }catch(e){error=`Routing config: ${e.message}. Using the last valid configuration.`;}
    return current;
  }};
}
module.exports={configFile,migrate};
