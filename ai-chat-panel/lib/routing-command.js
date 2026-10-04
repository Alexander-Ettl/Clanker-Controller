'use strict';
const net=require('node:net');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {benchmark}=require('./routing-benchmark');
// CLI asks the live extension to run the benchmark. Keys remain in SecretStorage.
function serve(context,routing,getModels,dir,quotas) {
  const token=crypto.randomBytes(32).toString('hex');
  const pipe=process.platform==='win32'?`\\\\.\\pipe\\clanker-router-${crypto.randomUUID()}`:path.join(dir,`router-${crypto.randomUUID()}.sock`);
  const endpoint=path.join(dir,'router-endpoint.json');
  let busy=false;
  const server=net.createServer(socket=>{
    socket.setTimeout(10000);socket.on('timeout',()=>socket.destroy());socket.on('error',()=>{});
    let input='';socket.on('data',async chunk=>{
      input+=chunk;if(input.length>4096){socket.destroy();return;}if(!input.includes('\n'))return;
      socket.removeAllListeners('data');
      try {
        const request=JSON.parse(input.trim());if(request.token!==token) throw Error('Unauthorized router command');
        if(busy) throw Error('A benchmark is already running');
        if(request.command==='confirm-smoke') { if(!context.globalState.get('routingSmokeReport'))throw Error('Generate and inspect the smoke report first'); await context.globalState.update('routingSmokeConfirmed',true);socket.end(JSON.stringify({checklist:['Smoke confirmation recorded; --n 50 is now available.']})+'\n');return; }
        if(request.command!=='benchmark')throw Error('Unknown command');busy=true;socket.setTimeout(0);
        // Manual mode still benchmarks recommendations; shadow preserves current settings and evaluates router picks.
        const result=await benchmark({router:routing.router,models:getModels(),source:dir,n:request.n??10,confirmed:context.globalState.get('routingSmokeConfirmed',false),out:path.join(dir,'router-report.html'),quotas:await quotas()});
        await context.globalState.update('routingSmokeReport',result.file);
        socket.end(JSON.stringify({file:result.file,checklist:result.checklist})+'\n');
      }catch(error){socket.end(JSON.stringify({error:error.message})+'\n');}finally{busy=false;}
    });
  });
  server.on('error',()=>{});
  fs.mkdirSync(dir,{recursive:true});
  server.listen(pipe,()=>fs.writeFileSync(endpoint,JSON.stringify({pipe,token}),{mode:0o600}));
  return {dispose(){server.close();try{const saved=JSON.parse(fs.readFileSync(endpoint,'utf8'));if(saved.token===token)fs.unlinkSync(endpoint);}catch{}}};
}
module.exports={serve};
