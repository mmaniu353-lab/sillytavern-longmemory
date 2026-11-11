const {normalizeInput,digest}=require('./normalize.cjs');
function mountLibraryRoutes(router,controller,salt,makeScopes){
 const route=(path,handler)=>router.post('/library/'+path,async(req,res)=>{
  try{const b=req.body||{},scope=makeScopes(req.user,b.world,b.chat,salt),collection=b.collection??'default';
   if(typeof collection!=='string'||!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(collection))throw Error('invalid_collection');
   res.json(await handler(b,{user_scope:scope.user_scope,world:scope.world,collection}));
  }catch(e){const bad=/invalid|limit|quota|hash|duplicate|conflict|too.large|unsafe|unknown|mismatch/i.test(e.message);res.status(bad?400:503).json({error:bad?'invalid_request':'memory_unavailable'});}
 });
 const parse=b=>normalizeInput({name:b.name,raw:b.raw});
 const call=(op,args)=>controller.call(op,args,60000);
 route('preview',async b=>{const p=parse(b);return {documents:p.documents.map(d=>({id:d.id,title:d.title,format:d.format,messages:d.messages.length,sha256:d.sha256,projectionChunks:d.projectionChunks})),messages:p.documents.reduce((n,d)=>n+d.messages.length,0),warnings:p.warnings,rawSha256:p.rawSha256};});
 route('import',async(b,scope)=>{const p=parse(b);const documents=p.documents.map(({projectionChunks,...doc})=>doc);return call('import_documents',{...scope,documents});});
 route('list',async(_b,scope)=>({documents:await call('list_vault',scope)}));
 route('export',async(_b,scope)=>{const snapshot=await call('export_vault',scope);return {schema:'longmemory.archive.v1',snapshot,sha256:digest(JSON.stringify(snapshot)),note:'Integrity only; not proof of authenticity. Contains private originals; do not publish.'};});
 route('restore',async(b,scope)=>{
  const a=b.archive;if(!a||a.schema!=='longmemory.archive.v1'||!a.snapshot||a.snapshot.schemaVersion!==1||a.sha256!==digest(JSON.stringify(a.snapshot))||!Array.isArray(a.snapshot.documents)||Buffer.byteLength(JSON.stringify(a),'utf8')>160*1024*1024)throw Error('invalid_archive');
  return call('import_documents',{...scope,documents:a.snapshot.documents});
 });
 route('search',async(b,scope)=>{
  if(typeof b.query!=='string'||!b.query.trim()||b.query.length>4000||!['keyword','exact'].includes(b.mode||'keyword'))throw Error('invalid_query');
  return {matches:await call('search_vault',{...scope,query:b.query,mode:b.mode||'keyword',limit:12,max_chars:6000})};
 });
 route('read',async(b,scope)=>{
  if(![b.documentId,b.messageId].every(x=>typeof x==='string'&&x.length>0&&x.length<=160))throw Error('invalid_item');
  return {item:await call('read_vault_item',{...scope,documentId:b.documentId,messageId:b.messageId,...(b.revision?{revision:b.revision}:{})})};
 });
 route('rebuild',async(_b,scope)=>call('rebuild_index',scope));
}
module.exports={mountLibraryRoutes};
