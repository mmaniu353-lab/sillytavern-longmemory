import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
export async function verifyVendor(root='vendor/threadshelf'){
 const pin=JSON.parse(await readFile(root+'/PROVENANCE.json','utf8'));
 if(pin.commit!=='f13b721561305c3b040dc701ce86553ec36c4447')throw Error('Unexpected ThreadShelf source revision');
 for(const [file,expected]of Object.entries(pin.files)){
  if(!['parser.ts','chunking.ts','model-label.ts','LICENSE'].includes(file))throw Error('Unexpected vendored file');
  const bytes=(await readFile(root+'/'+file,'utf8')).replace(/\r\n/g,'\n');
  if(createHash('sha256').update(bytes).digest('hex')!==expected)throw Error('Vendored source mismatch: '+file);
 }
 if(Object.keys(pin.files).length!==4)throw Error('Incomplete vendored source pin');return pin;
}
