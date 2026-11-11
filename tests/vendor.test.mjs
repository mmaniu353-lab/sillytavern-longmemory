import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,cp,readFile,writeFile,rm} from 'node:fs/promises';import {resolve} from 'node:path';import {verifyVendor} from '../scripts/verify-vendor.mjs';
test('pinned upstream contents are checked and changes cannot self-approve at build',async()=>{
 await verifyVendor();const dir=await mkdtemp(resolve('.test-run-vendor-'));try{await cp('vendor/threadshelf',dir,{recursive:true});await writeFile(dir+'/parser.ts',(await readFile(dir+'/parser.ts','utf8'))+'\n// modified');await assert.rejects(()=>verifyVendor(dir),/mismatch/);}finally{await rm(dir,{recursive:true,force:true});}
});
