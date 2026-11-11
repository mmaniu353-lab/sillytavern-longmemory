import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url),{normalizeInput}=require('../plugin/normalize.cjs');
const hash=s=>createHash('sha256').update(s).digest('hex');
test('Markdown keeps exact raw and citations while import is read-only data',()=>{
 const raw='# Synthetic\n你好 e\u0301 😀\n<script>bad()</script>\n![image](https://invalid.example/x)';
 const {documents}=normalizeInput({name:'notes.md',raw});assert.equal(documents[0].raw,raw);assert.equal(documents[0].sha256,hash(raw));assert.equal(documents[0].messages[0].text,raw);assert.equal(documents[0].format,'markdown');
});
test('long ST JSONL preserves raw suffix and separates system messages',()=>{
 const long='中文😀'.repeat(7000)+'TAIL';const raw=[{user_name:'Invented'}, {mes:long,is_user:true}, {mes:'note',is_system:true}].map(JSON.stringify).join('\n');
 const doc=normalizeInput({name:'chat.jsonl',raw}).documents[0];assert.equal(doc.messages[0].text,long);assert.equal(doc.messages[1].role,'system');assert.equal(doc.sha256,hash(raw));
});
test('Workbench rich data stays in raw and extraction is explicitly a projection',()=>{
 const raw=JSON.stringify({messages:[{id:'m1',sender:'Invented',text:'Hello',role:'user',blocks:[{type:'image',url:'https://invalid.example/a'}]}]});
 const doc=normalizeInput({name:'chat.json',raw}).documents[0];assert.equal(doc.messages[0].text,'Hello');assert.match(doc.warnings.join(' '),/projection|投影/);assert.equal(doc.raw,raw);
});
test('upstream parser is really used and keeps separate OpenAI conversations',()=>{
 const make=(id,text)=>({id,title:id,current_node:'a',mapping:{a:{id:'a',parent:null,message:{author:{role:'user'},content:{content_type:'text',parts:[text]}}}}});
 const {documents}=normalizeInput({name:'export.json',raw:JSON.stringify([make('one','你好'),make('two','world')])});assert.equal(documents.length,2);assert.equal(documents[0].messages[0].text,'你好');assert.notEqual(documents[0].id,documents[1].id);
});
test('no silent empty parse, unsafe names, duplicate IDs or quota overflow',()=>{
 for(const input of [{name:'../secret.md',raw:'hello'},{name:'x.json',raw:'{}'},{name:'x.md',raw:''},{name:'x.json',raw:'{'},{name:'x.md',raw:'a'.repeat(1048577)}])assert.throws(()=>normalizeInput(input));
 const raw=JSON.stringify({messages:[{id:'same',text:'a'},{id:'same',text:'b'}]});assert.throws(()=>normalizeInput({name:'x.json',raw}));
});
test('duplicate upstream conversation identities fail during preview, not only commit',()=>{
 const c={id:'same',current_node:'a',mapping:{a:{message:{author:{role:'user'},content:{content_type:'text',parts:['hello']}}}}};assert.throws(()=>normalizeInput({name:'x.json',raw:JSON.stringify([c,c])}));
});
