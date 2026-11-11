import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{createController}=require('../plugin/index.cjs');
test('real Python RPC persists confirmed Unicode and scoped knowledge through restart',async()=>{
 const dir=await mkdtemp(resolve('.test-run-rpc-')),workerPath=resolve('plugin/memory_worker.py'),dbPath=join(dir,'temp.sqlite3');let c=createController({workerPath,dbPath});
 try{
  const scopes={user_scope:'test-user',world:'test-world',chat:'test-chat'},text='中文😀'.repeat(9000)+'TAIL';
  const ack=await c.call('put_confirmed',{...scopes,source:'source',revision:1,text,role:'user'});assert.equal(ack.status,'stored');assert.equal(ack.sha256.length,64);
  const doc={id:'note',title:'Synthetic note',format:'text',raw:'orbital lighthouse',sha256:require('node:crypto').createHash('sha256').update('orbital lighthouse').digest('hex'),messages:[{id:'m',role:'note',text:'orbital lighthouse'}],warnings:[]};
  await c.call('import_documents',{user_scope:scopes.user_scope,world:scopes.world,collection:'default',documents:[doc]});await c.stop();c=createController({workerPath,dbPath});
  assert.equal((await c.call('get_item',{...scopes,source:'source'})).body,text);
  const args={user_scope:scopes.user_scope,world:scopes.world,collection:'default',query:'lighthouse'};
  assert.equal((await c.call('search_vault',args))[0].documentId,'note');assert.deepEqual(await c.call('search_vault',{...args,user_scope:'other'}),[]);
 }finally{await c.stop();await rm(dir,{recursive:true,force:true});}
});
