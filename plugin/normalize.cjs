const crypto=require('node:crypto');
const {parseConversationGroups,detectProvider,chunkTurns,portableModelLabel}=require('./threadshelf.cjs');
const PIN='f13b721561305c3b040dc701ce86553ec36c4447';
const digest=s=>crypto.createHash('sha256').update(s,'utf8').digest('hex');
const bytes=s=>Buffer.byteLength(s,'utf8');
function message(id,role,text,meta={}){
 if(typeof text!=='string'||!text.trim()||bytes(text)>1048576||typeof id!=='string'||!id||id.length>160)throw Error('invalid_message');
 if(!['user','assistant','system','note'].includes(role))role='note';
 return {id,role,text,meta};
}
function normalizeInput(input){
 if(!input||typeof input!=='object')throw Error('invalid_input');const {name,raw}=input;
 if(typeof name!=='string'||!name||name.length>240||/[\\/:\x00-\x1f]/.test(name)||name==='.'||name==='..')throw Error('invalid_name');
 if(typeof raw!=='string'||!raw.trim()||bytes(raw)>32*1024*1024||Buffer.from(raw).toString('utf8')!==raw)throw Error('invalid_file');
 const sha256=digest(raw),base=digest('file\0'+name),warnings=[];let groups,format;
 if(/\.(md|txt)$/i.test(name)){format=/\.md$/i.test(name)?'markdown':'text';groups=[{key:'note',title:name,messages:[message('note:0','note',raw)]}];}
 else if(/\.jsonl$/i.test(name)){
  format='sillytavern-jsonl';const lines=raw.split(/\r?\n/).filter(l=>l.trim());if(lines.length>10001)throw Error('invalid_count');
  const rows=lines.map(l=>JSON.parse(l));if(!rows[0]||!('user_name'in rows[0]||'name'in rows[0]||'chat_metadata'in rows[0]))throw Error('invalid_header');
  const messages=rows.slice(1).map((m,i)=>message(String(m.extra?.long_memory_bridge?.source||'turn:'+i),m.is_system?'system':m.is_user?'user':'assistant',m.mes,{position:i}));
  groups=[{key:'chat',title:name,messages}];warnings.push('Text projection only; attachments and original metadata remain in raw evidence.');
 }else if(/\.json$/i.test(name)){
  const data=JSON.parse(raw);
  if(detectProvider(data)==='unknown'&&data&&Array.isArray(data.messages)){
   format='workbench-json';groups=[{key:'chat',title:String(data.title||name).slice(0,240),messages:data.messages.map((m,i)=>message(String(m.id||'turn:'+i),m.role||'note',m.text??m.content??'',{position:i,sender:typeof m.sender==='string'?m.sender.slice(0,240):''}))}];
   warnings.push('Text projection; blocks, media references and unsupported metadata remain in raw evidence.');
  }else{
   format=detectProvider(data);if(format==='unknown')throw Error('invalid_format');
   const parsed=parseConversationGroups(data,{includeUser:true,includeAi:true,includeThinking:false});if(parsed.error)throw Error('invalid_export');
   groups=parsed.conversations.map(c=>({key:c.key,title:c.title,messages:c.turns.map((t,i)=>message('turn:'+i,t.user!==undefined?'user':'assistant',t.user??t.ai??'',{position:i,model:portableModelLabel(t.model),createdAt:t.createdAt}))}));
   warnings.push('ThreadShelf selected-branch text projection; thinking excluded. Original branches/media/unsupported fields remain in raw evidence, not necessarily searchable.');
  }
 }else throw Error('invalid_format');
 if(!groups?.length||groups.length>10000)throw Error('invalid_empty_export');let count=0;
 const documents=groups.map(group=>{
  if(!group.messages.length||new Set(group.messages.map(m=>m.id)).size!==group.messages.length||(count+=group.messages.length)>10000)throw Error('invalid_messages');
  const turns=group.messages.map(m=>m.role==='user'?{user:m.text}:{ai:m.text});
  return {id:digest(base+'\0'+group.key),title:String(group.title||name).slice(0,240),format,raw,sha256,messages:group.messages,warnings:[...warnings],parserRevision:PIN,projectionChunks:chunkTurns(turns,{sourceFile:name,provider:format}).length};
 });
 if(new Set(documents.map(d=>d.id)).size!==documents.length)throw Error('invalid_duplicate_documents');
 if(documents.reduce((n,d)=>n+bytes(d.raw),0)>128*1024*1024)throw Error('invalid_total');
 return {documents,warnings,rawSha256:sha256,parserRevision:PIN};
}
module.exports={normalizeInput,digest};
