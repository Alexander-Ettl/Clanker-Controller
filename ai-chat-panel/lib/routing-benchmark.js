'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {redact}=require('./routing');
function records(dir) {
  const found=[];
  function visit(folder) {
    if(!fs.existsSync(folder)) return;
    for(const entry of fs.readdirSync(folder,{withFileTypes:true})) {
      const file=path.join(folder,entry.name);
      if(entry.isDirectory() && ['projects','chats'].includes(entry.name) || entry.isDirectory() && folder.endsWith('projects')) visit(file);
      else if(entry.isFile() && entry.name.endsWith('.json') && folder.endsWith('chats')) {
        try {
          const chat=JSON.parse(fs.readFileSync(file,'utf8'));
          const messages=chat.messages||[];
          for(let i=0;i<messages.length;i++) {
            const m=messages[i]; if(m.role!=='user' || typeof m.text!=='string' || m.text.trim().length<60 || /^\/(?:compact|help|status)\b/.test(m.text)) continue;
            const attachments=(m.attachments||[]).filter(p=>typeof p==='string' && /\.(png|jpe?g|webp)$/i.test(p) && fs.existsSync(p));
            const reply=messages.slice(i+1).find(x=>x.role==='assistant');
            found.push({prompt:m.text,project:chat.projectId||path.dirname(folder),at:m.at||chat.createdAt,screenshot:attachments.length>0,attachments,original_pick:reply?.modelId||reply?.modelLabel||chat.modelId||null,context_tokens:m.contextTokens||0});
          }
        } catch { /* malformed record does not stop sampling */ }
      }
    }
  }
  visit(dir); return found;
}
function sample(input,n) {
  const unique=[...new Map(input.map(r=>[r.prompt,r])).values()].sort((a,b)=>String(a.at).localeCompare(String(b.at)));
  const images=unique.filter(r=>r.screenshot),text=unique.filter(r=>!r.screenshot);
  if(unique.length<n) throw Error(`Only ${unique.length} nontrivial real prompts found; need ${n}.`);
  const imageCount=Math.min(images.length,Math.max(3,Math.round(n*.3)),n);
  if(n>=10 && imageCount<2) throw Error('Need at least two real screenshot prompts for the smoke run.');
  // Round-robin projects and spread within each project's time range.
  function spread(pool,count) {
    const groups=[...new Set(pool.map(r=>r.project))].map(p=>pool.filter(r=>r.project===p));
    const picked=[];
    while(picked.length<count && groups.some(g=>g.length)) for(const g of groups) {
      if(picked.length>=count) break;
      if(g.length) picked.push(g.splice(Math.floor(g.length/2),1)[0]);
    }
    return picked;
  }
  const picks=[...spread(images,imageCount),...spread(text,n-imageCount)];
  if(picks.length<n) picks.push(...unique.filter(r=>!picks.includes(r)).slice(0,n-picks.length));
  return picks;
}
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function report(rows,models) {
  const counts={};for(const row of rows) counts[row.pick||'No eligible model']=(counts[row.pick||'No eligible model']||0)+1;
  const colors=['#627bff','#f0924c','#44b8a5','#d375bc','#a6a745','#8565c7'];let angle=0;
  const slices=Object.entries(counts).map(([id,count],i)=>{const start=angle;angle+=count/rows.length*Math.PI*2;const x=a=>100+80*Math.cos(a),y=a=>100+80*Math.sin(a);return `<path fill="${colors[i%colors.length]}" d="M100 100 L${x(start)} ${y(start)} A80 80 0 ${angle-start>Math.PI?1:0} 1 ${x(angle)} ${y(angle)} Z"/>`;}).join('');
  const pie=Object.keys(counts).length===1?`<circle cx="100" cy="100" r="80" fill="${colors[0]}"/>`:slices;
  const legend=Object.entries(counts).map(([id,count],i)=>`<li><span style="color:${colors[i%colors.length]}">●</span> ${escape(id)}: ${count}</li>`).join('');
  const options=['',...models.map(m=>m.id)];
  const fallbacks=r=>(r.attempts||[]).filter(a=>a.status==='fallback').map(a=>`<br><small>${escape(a.tier)}: ${escape(a.reason)}</small>`).join('');
  const table=rows.map((r,i)=>`<tr class="${r.original_pick && r.original_pick!==r.pick?'disagree':''}"><td>${escape(r.prompt)}${r.screenshot?' 📷':''}</td><td>${escape(r.pick)}</td><td>${Math.round(r.confidence*100)}%</td><td>${escape(r.tier)} · ${r.latency_ms}ms<br>${escape(r.action)} (${escape(r.reason)})${fallbacks(r)}</td><td>${escape(r.original_pick||'Unknown')}</td><td><select aria-label="Better model for row ${i+1}" data-row="${i}">${options.map(id=>`<option value="${escape(id)}">${escape(id||'Agree')}</option>`).join('')}</select><input aria-label="Note for row ${i+1}" placeholder="Optional note" data-note="${i}"></td></tr>`).join('');
  const data=JSON.stringify(rows).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src 'none'"><title>Router smoke report</title><style>:root{color-scheme:light dark;font:15px system-ui;background:light-dark(#f5f6fa,#161820);color:light-dark(#222,#eef)}body{max-width:1100px;margin:auto;padding:24px}header{display:flex;align-items:center;gap:24px;flex-wrap:wrap}svg{width:160px;height:160px}li{list-style:none;margin:8px 0}table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;padding:12px;border-bottom:1px solid #8885;vertical-align:top}td:first-child{min-width:180px;max-width:350px;overflow-wrap:anywhere}.disagree{background:#f0a04018}button,select,input{font:inherit;padding:9px;border:1px solid #8886;border-radius:8px;max-width:180px}input{display:block;margin-top:8px}.table{overflow:auto}button{cursor:pointer;margin:16px 0;background:#627bff;color:white}small{opacity:.7}</style><h1>Router smoke report</h1><small>${rows.length} redacted requests. Destination models were not called. Highlighted rows disagree with the original pick.</small><header><svg viewBox="0 0 200 200" role="img" aria-label="Model pick distribution">${pie}</svg><ul>${legend}</ul></header><button id="export">Export feedback</button><div class="table"><table><thead><tr><th>Prompt</th><th>Model</th><th>Confidence</th><th>Tier / continuity</th><th>Original pick</th><th>Feedback</th></tr></thead><tbody>${table}</tbody></table></div><script>const rows=${data};document.getElementById('export').onclick=()=>{const feedback=rows.map((r,i)=>({...r,better_model:document.querySelector('[data-row="'+i+'"]').value||r.pick,note:document.querySelector('[data-note="'+i+'"]').value}));const url=URL.createObjectURL(new Blob([JSON.stringify({version:1,feedback},null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='router-feedback.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};</script></html>`;
}
async function benchmark({router,models,source,n=10,confirmed=false,out,quotas={}}) {
  if(!Number.isInteger(n)||n<1||n>500) throw Error('--n must be an integer between 1 and 500');
  if(n>10&&!confirmed) throw Error('Runs above 10 are locked until you confirm the first smoke report works end to end.');
  const selected=sample(records(source),n),rows=[];
  const keys=await Promise.all(['routingCloudflareAccount','routingCloudflareToken','groqApiKey'].map(k=>router.secrets.get(k)));
  for(const record of selected) {
    const safePrompt=redact(record.prompt,keys);
    const decision=await router.route({...record,prompt:safePrompt,benchmark:true},models,quotas);
    rows.push({...decision,prompt:safePrompt.slice(0,200),screenshot:record.screenshot,original_pick:models.find(m=>m.id===record.original_pick||m.label===record.original_pick)?.id||redact(record.original_pick,keys),project:redact(record.project,keys)});
  }
  const html=report(rows,models);
  if(keys.filter(Boolean).some(k=>html.includes(k))) throw Error('Secret scan failed; report was not written');
  fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,html);
  const tiers=[...new Set(rows.map(r=>r.tier))];
  return {file:out,rows,checklist:[`PASS sampling: ${rows.length} real prompts, ${rows.filter(r=>r.screenshot).length} screenshots`,`PASS redaction ran`,...['cloudflare','groq','deterministic'].map(t=>`${tiers.includes(t)?'PASS':'NOT EXERCISED'} tier ${t}`),'PASS report generated','PENDING feedback download: confirm in browser','PASS known credential scan; manually inspect redacted snippets','Reminder: after confirming the 10-prompt smoke run, scale up with --n 50.']};
}
module.exports={records,sample,report,benchmark};
