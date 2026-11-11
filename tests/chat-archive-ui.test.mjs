import test from 'node:test';import assert from 'node:assert/strict';import {JSDOM} from 'jsdom';import {mountLibrary} from '../extension/library.mjs';
test('current chat archive is previewed with complete original metadata before any write',async()=>{
 const dom=new JSDOM('<main></main>');globalThis.document=dom.window.document;globalThis.window=dom.window;
 const calls=[],chat=[{mes:'tail😀'.repeat(4000),is_user:true,extra:{synthetic:'kept'}}];
 const api=mountLibrary({container:document.querySelector('main'),getScope:()=>({world:'world',chat:'chat'}),getChat:()=>chat,request:async(path,body)=>{calls.push({path,body});return{messages:1,documents:[],warnings:[]};}});
 await api.previewChat();assert.equal(calls.length,1);assert.equal(calls[0].path,'/library/preview');const archived=JSON.parse(calls[0].body.raw.split('\n')[1]);assert.equal(archived.mes,chat[0].mes);assert.deepEqual(archived.extra,chat[0].extra);dom.window.close();
});
