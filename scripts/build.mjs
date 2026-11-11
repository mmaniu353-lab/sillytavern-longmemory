import {build} from 'esbuild';
import {mkdir,cp,readdir} from 'node:fs/promises';
import {verifyVendor} from './verify-vendor.mjs';
await verifyVendor();
await build({entryPoints:['scripts/upstream-entry.ts'],outfile:'plugin/threadshelf.cjs',bundle:true,platform:'node',format:'cjs',target:'node22',treeShaking:true,legalComments:'inline',banner:{js:'// ThreadShelf selected modules; MIT (c) 2026 Chrystian Schutz. See THREADSHELF-LICENSE.txt.'}});
await cp('vendor/threadshelf/LICENSE','plugin/THREADSHELF-LICENSE.txt');
await mkdir('dist',{recursive:true});
for(const dir of ['extension','plugin']){await mkdir('dist/'+dir,{recursive:true});for(const name of await readdir(dir)){if(/\.(?:js|mjs|cjs|py|css|json|txt)$/.test(name))await cp(dir+'/'+name,'dist/'+dir+'/'+name);}}
await cp('LICENSE','dist/LICENSE');console.log('Built pinned parser and explicit extension/plugin distribution.');
