import assert from 'node:assert/strict';
import express from 'express';
import {chromium} from 'playwright';
import {createRequire} from 'node:module';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const require=createRequire(import.meta.url),{createController,mountRouter}=require('../plugin/index.cjs');
const dir=await mkdtemp(resolve('.test-run-browser-')),app=express(),controller=createController({dbPath:join(dir,'temp.sqlite3'),workerPath:resolve('plugin/memory_worker.py')});
app.use(express.json({limit:'160mb'}));app.use('/extension',express.static(resolve('extension')));
app.get('/',(_q,r)=>r.type('html').send('<meta charset="utf-8"><title>LongMemory synthetic integration</title><main id="app"></main><script type="module">import {mountLibrary,getKnowledgePrompt} from "/extension/library.mjs";window.scope={world:"character:synthetic",chat:"synthetic-chat"};window.library=mountLibrary({container:document.querySelector("#app"),getScope:()=>window.scope,request:async(p,b)=>{const r=await fetch("/api/plugins/long-memory-bridge"+p,{method:"POST",headers:{"content-type":"application/json","x-synthetic":"1"},body:JSON.stringify(b)});if(!r.ok)throw Error("HTTP "+r.status);return r.json();}});window.promptForTest=()=>getKnowledgePrompt(window.scope,2000,async s=>s.length);</script>'));
app.use((q,_r,next)=>{if(q.headers['x-synthetic']==='1')q.user={profile:{handle:'synthetic-user'}};next();});
const router=express.Router();mountRouter(router,controller,Buffer.alloc(32,7));app.use('/api/plugins/long-memory-bridge',router);
const server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));}),base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true}),page=await browser.newPage({acceptDownloads:true});let checks=0;
const step=async(label,fn)=>{await fn();console.log(`ok ${++checks} - ${label}`);};
try{
 await step('standalone synthetic host mounts library without importing or enabling injection',async()=>{await page.goto(base);await page.locator('#long_memory_library').waitFor();await page.locator('summary').click();assert.equal(await page.locator('[data-k=inject]').isChecked(),false);});
 const raw='# Invented knowledge\nThe orbital lighthouse is cyan.\n<script>window.BAD=true</script>\n![remote](https://invalid.example/private.png)';
 await step('file preview is explicit, original content stays inert, confirmed import persists',async()=>{await page.locator('[data-k=file]').setInputFiles({name:'synthetic.md',mimeType:'text/markdown',buffer:Buffer.from(raw)});await page.locator('[data-k=commit]').waitFor({state:'visible'});await page.waitForFunction(()=>!document.querySelector('[data-k=commit]').disabled);await page.locator('[data-k=commit]').click();await page.waitForFunction(()=>document.querySelector('[data-k=status]').textContent.includes('imported'));assert.equal(await page.evaluate(()=>window.BAD),undefined);});
 await step('scoped lexical search shows citations and reads exact canonical evidence',async()=>{await page.locator('[data-k=query]').fill('lighthouse');await page.locator('[data-k=search]').click();await page.locator('[data-k=results] article').waitFor();assert.match(await page.locator('[data-k=results]').innerText(),/lighthouse/);await page.getByRole('button',{name:'查看原文',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-k=status]').textContent.includes('sha256'));assert.equal(await page.locator('img').count(),0);});
 await step('selected citations require opt-in and do not leak after chat switch',async()=>{assert.equal(await page.evaluate(()=>window.promptForTest()),'');await page.getByRole('button',{name:'选入提示词',exact:true}).click();await page.locator('[data-k=inject]').check();assert.match(await page.evaluate(()=>window.promptForTest()),/lighthouse/);await page.evaluate(()=>window.scope={world:'other',chat:'different'});assert.equal(await page.evaluate(()=>window.promptForTest()),'');await page.evaluate(()=>window.scope={world:'character:synthetic',chat:'synthetic-chat'});});
 await step('downloaded archive hashes and real restore are checked; altered snapshot rejected',async()=>{const download=page.waitForEvent('download');await page.locator('[data-k=export]').click();const dl=await download;const path=join(dir,'backup.json');await dl.saveAs(path);const pack=JSON.parse(await readFile(path,'utf8'));assert.equal(pack.schema,'longmemory.archive.v1');const body={world:'character:synthetic',chat:'synthetic-chat',collection:'restored',archive:pack};const headers={'content-type':'application/json','x-synthetic':'1'};const restored=await fetch(base+'/api/plugins/long-memory-bridge/library/restore',{method:'POST',headers,body:JSON.stringify(body)});assert.equal(restored.status,200);pack.snapshot.documents[0].raw+='tamper';const bad=await fetch(base+'/api/plugins/long-memory-bridge/library/restore',{method:'POST',headers,body:JSON.stringify(body)});assert.equal(bad.status,400);});
 await step('missing authenticated scope is rejected before any storage access',async()=>{const r=await fetch(base+'/api/plugins/long-memory-bridge/library/list',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(r.status,400);});
 await step('narrow host panels keep labels and control bounds inside the library',async()=>{
  await page.addStyleTag({url:base+'/extension/style.css'});
  await page.addStyleTag({content:'body{margin:0;font:15px sans-serif}#app{width:352px}label{white-space:nowrap}'});
  for(const width of [352,280,220]){
   await page.locator('#app').evaluate((el,width)=>el.style.width=width+'px',width);
   const overflow=await page.locator('#long_memory_library').evaluate(panel=>{
    const bounds=panel.getBoundingClientRect(),problems=[];
    for(const el of panel.querySelectorAll('label,button,input,select')){
     const name=el.dataset.k||el.textContent.trim(),rect=el.getBoundingClientRect();
     if(rect.left<bounds.left-1||rect.right>bounds.right+1)problems.push(name+': control outside panel');
     if(el.matches('label')&&el.getClientRects().length!==1)problems.push(name+': label split across action rows');
     if(el.matches('label'))for(const node of el.childNodes){if(node.nodeType!==Node.TEXT_NODE)continue;const range=document.createRange();range.selectNodeContents(node);for(const text of range.getClientRects())if(text.right>bounds.right+1)problems.push(name+': text outside panel');}
    }
    return problems;
   });
   assert.deepEqual(overflow,[],`library control bounds at ${width}px`);
  }
 });
 await page.locator('[data-k=query]').fill('lighthouse');await page.locator('[data-k=search]').click();await page.locator('[data-k=results] article').waitFor();await page.screenshot({path:process.env.LONG_MEMORY_SCREENSHOT||join(dir,'synthetic.png'),fullPage:true});
 console.log(`# ${checks} synthetic Chromium checks passed; actual host is a separate test.`);
}finally{await browser.close();await new Promise(r=>server.close(r));await controller.stop();await rm(dir,{recursive:true,force:true});}
