import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{mountLibraryRoutes}=require('../plugin/library-routes.cjs');
function fixture(user={profile:{handle:'synthetic'}}){
 const routes=new Map(),calls=[],controller={async call(op,args){calls.push({op,args});return op==='export_vault'?{schemaVersion:1,documents:[]}:op==='list_vault'?[]:{imported:1,unchanged:0};}};
 const router={post(path,fn){routes.set(path,fn);}},scope=u=>{if(!u?.profile?.handle)throw Error('invalid_scope');return{user_scope:u.profile.handle,world:'hashed-world',chat:'hashed-chat'};};mountLibraryRoutes(router,controller,'unused',scope);
 return{calls,async request(path,body){let result,code=200;await routes.get(path)({user,body},{status(c){code=c;return this;},json(v){result=v;}});return{code,result};}};
}
test('preview is bounded and performs no write; import ignores forged owners',async()=>{
 const f=fixture(),body={world:'character:demo',chat:'chat',name:'note.md',raw:'invented source',collection:'default',user_scope:'victim'};
 assert.equal((await f.request('/library/preview',body)).result.messages,1);assert.equal(f.calls.length,0);
 assert.equal((await f.request('/library/import',body)).code,200);assert.equal(f.calls[0].args.user_scope,'synthetic');assert.equal(f.calls[0].args.world,'hashed-world');
});
test('missing authenticated user and invalid collection cannot reach storage',async()=>{
 const a=fixture(null);assert.equal((await a.request('/library/list',{})).code,400);assert.equal(a.calls.length,0);
 const f=fixture();assert.equal((await f.request('/library/list',{collection:'../../other'})).code,400);assert.equal(f.calls.length,0);
});
test('export/restore checks manifest before writes, never trusts owner or paths',async()=>{
 const f=fixture(),body={world:'x',chat:'y',collection:'default'};const pack=(await f.request('/library/export',body)).result;
 assert.equal(pack.schema,'longmemory.archive.v1');pack.snapshot.documents.push({raw:'tampered'});const before=f.calls.length;assert.equal((await f.request('/library/restore',{...body,archive:pack})).code,400);assert.equal(f.calls.length,before);
});
test('correctly hashed unknown snapshot schema is rejected at server boundary',async()=>{
 const f=fixture(),snapshot={schemaVersion:999,documents:[]},sha256=require('node:crypto').createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
 assert.equal((await f.request('/library/restore',{world:'x',chat:'y',archive:{schema:'longmemory.archive.v1',snapshot,sha256}})).code,400);assert.equal(f.calls.length,0);
});
