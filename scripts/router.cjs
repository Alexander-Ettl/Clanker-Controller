#!/usr/bin/env node
'use strict';
const net=require('node:net');const fs=require('node:fs');const path=require('node:path');
const args=process.argv.slice(2),command=args.shift()||'benchmark';
const { DATA_FOLDER } = require('../ai-chat-panel/lib/session-dir.js');
const globalStorage = path.join(process.env.APPDATA || '', 'Antigravity IDE', 'User', 'globalStorage');
const sharedSession = path.join(globalStorage, DATA_FOLDER, 'session');
let n=10,storage=process.env.AI_CHAT_PANEL_SESSION_DIR||(fs.existsSync(sharedSession) ? sharedSession : path.join(globalStorage,'local.ai-chat-panel','session'));
let feedbackFile;
for(let i=0;i<args.length;i++) { if(args[i]==='--n')n=Number(args[++i]);else if(args[i]==='--storage')storage=args[++i];else if(args[i]==='--feedback')feedbackFile=path.resolve(args[++i]);else {console.error(`Unknown option ${args[i]}`);process.exit(1);} }
if(!['benchmark','confirm-smoke'].includes(command)||!Number.isInteger(n)||n<1||n>500){console.error('Usage: router benchmark [--n 10] [--storage <session folder>] | router confirm-smoke');process.exit(1);}
try {
  const endpoint=JSON.parse(fs.readFileSync(path.join(storage,'router-endpoint.json'),'utf8'));
  const socket=net.connect(endpoint.pipe,()=>socket.write(JSON.stringify({token:endpoint.token,command,n,feedbackFile})+'\n'));
  let output='';socket.on('data',data=>output+=data);
  socket.on('end',()=>{try{const result=JSON.parse(output);if(result.error){console.error(result.error);process.exitCode=1;}else{for(const line of result.checklist)console.log(line);if(result.file)console.log(`Report: ${result.file}`);}}catch{console.error('Invalid response from router command');process.exitCode=1;}});
  socket.on('error',()=>{console.error('Reload the IDE with Clanker enabled before running the router command.');process.exitCode=1;});
}catch{console.error('Router command is unavailable. Reload the IDE with Clanker enabled, or select its session folder using --storage.');process.exitCode=1;}
