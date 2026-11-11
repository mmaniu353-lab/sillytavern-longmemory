const fs=require('node:fs/promises'),crypto=require('node:crypto');
async function readHistory(filename,chat,known,cancelled){
 const before=await fs.lstat(filename);if(!before.isFile()||before.isSymbolicLink()||before.size>32*1024*1024)throw Error('archive_file_limit');
 const handle=await fs.open(filename,'r');let raw;
 try{const stat=await handle.stat();if(stat.size!==before.size||stat.ino!==before.ino)throw Error('archive_changed');
  const data=Buffer.alloc(stat.size+1);let offset=0;while(offset<data.length){if(cancelled())throw Error('archive_stopped');const {bytesRead}=await handle.read(data,offset,data.length-offset,offset);if(!bytesRead)break;offset+=bytesRead;}
  const after=await handle.stat();if(offset!==stat.size||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs)throw Error('archive_changed');raw=new TextDecoder('utf-8',{fatal:true}).decode(data.subarray(0,offset));
 }finally{await handle.close();}
 const lines=raw.split(/\r?\n/).filter(l=>l.trim());if(lines.length>2001)throw Error('archive_message_limit');
 const rows=lines.map(line=>JSON.parse(line));if(!rows[0]||typeof rows[0]!=='object'||!('user_name'in rows[0]||'name'in rows[0]||'chat_metadata'in rows[0]))throw Error('archive_invalid_header');
 let size=0;const items=[],seen=new Set(),now=Date.now()*1000;
 for(const [i,m] of rows.slice(1).entries()){
  if(cancelled())throw Error('archive_stopped');if(!m||typeof m!=='object')throw Error('archive_invalid_message');const tag=m.extra?.long_memory_bridge;
  if(m.is_system&&!tag?.offloaded||typeof m.mes!=='string'||!m.mes.trim())continue;
  if(Buffer.byteLength(m.mes,'utf8')>1048576)throw Error('archive_message_limit');
  const tagged=typeof tag?.source==='string'&&tag.source.length>0&&tag.source.length<=160&&Number.isSafeInteger(tag.revision)&&tag.revision>0;
  const source=tagged?tag.source:'legacy:'+crypto.createHash('sha256').update(JSON.stringify([chat,i])).digest('hex');
  if(seen.has(source))throw Error('archive_duplicate_source');seen.add(source);
  if(tagged&&known[source]>tag.revision)continue;
  const item={source,revision:tagged?tag.revision:Math.max(now+i,(known[source]||0)+1),text:m.mes,role:m.is_user?'user':'assistant'};
  size+=Buffer.byteLength(JSON.stringify(item),'utf8');if(size>8*1024*1024)throw Error('archive_batch_limit');items.push(item);
 }
 return items;
}
module.exports={readHistory};
