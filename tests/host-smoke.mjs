import assert from 'node:assert/strict';
import {execFile as execFileCallback, spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {chromium} from 'playwright';

const execFile = promisify(execFileCallback);
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceInput = process.env.ST_SOURCE;
assert.ok(sourceInput, 'ST_SOURCE must explicitly identify the read-only SillyTavern source checkout');
const source = await realpath(sourceInput);
assert.notEqual(source, project, 'Host source must differ from this project');
const expected = '51ad27fb86d39a3daca3adaa970375c9670c12df';
const {stdout: headText} = await execFile('git', ['-C', source, 'rev-parse', 'HEAD'], {windowsHide:true});
assert.equal(headText.trim(), expected, 'Host smoke requires the reviewed SillyTavern 1.18.0 commit');
const {stdout: packageText} = await execFile('git', ['-C', source, 'show', 'HEAD:package.json'], {windowsHide:true});
assert.equal(JSON.parse(packageText).version, '1.18.0');
await execFile(process.execPath, ['scripts/build.mjs'], {cwd:project, windowsHide:true});
const root = await mkdtemp(path.join(project, '.test-run-host-'));
const checked = target => {
    const absolute = path.resolve(target), relative = path.relative(root, absolute);
    assert.ok(relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)), 'Host path must stay beneath isolated test root');
    return absolute;
};
const host = checked(path.join(root, 'host')), data = checked(path.join(root, 'data'));
const archive = checked(path.join(root, 'source.zip')), config = checked(path.join(root, 'config.yaml'));
const state = checked(path.join(root, 'state')), junction = checked(path.join(host, 'node_modules'));
const evidence = path.join(project, 'outputs');
await mkdir(evidence, {recursive:true});
let child, browser, successful = false, serverLog = '', browserErrors = [], externalRequests = [], providerRequests = [];
const digest = value => createHash('sha256').update(value).digest('hex');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = {hostVersion:'1.18.0', hostCommit:expected, checks:[], screenshot:null};
const pass = name => {results.checks.push(name); console.log('PASS ' + name);};
try {
    await execFile('git', ['-C', source, 'archive', '--format=zip', '--output=' + archive, 'HEAD'], {windowsHide:true});
    await mkdir(host);
    if (process.platform === 'win32') {
        const quote = value => "'" + value.replaceAll("'", "''") + "'";
        await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
            `Expand-Archive -LiteralPath ${quote(checked(archive))} -DestinationPath ${quote(checked(host))}`], {windowsHide:true, timeout:120000});
    } else {
        await execFile('unzip', ['-q', archive, '-d', host], {timeout:120000});
    }
    await symlink(path.join(source, 'node_modules'), junction, process.platform === 'win32' ? 'junction' : 'dir');
    await cp(path.join(project, 'dist', 'plugin'), checked(path.join(host, 'plugins', 'long-memory-bridge')), {recursive:true});
    await cp(path.join(project, 'dist', 'extension'), checked(path.join(host, 'public', 'scripts', 'extensions', 'third-party', 'LongMemory')), {recursive:true});
    const port = await new Promise((resolve,reject) => {
        const probe = createServer(); probe.on('error',reject); probe.listen(0,'127.0.0.1',() => {const value=probe.address().port;probe.close(() => resolve(value));});
    });
    await writeFile(config, `listen: false\nport: ${port}\nprotocol:\n  ipv4: true\n  ipv6: false\nbrowserLaunch:\n  enabled: false\nautorun: false\nenableUserAccounts: false\nenableServerPlugins: true\nenableServerPluginsAutoUpdate: false\nextensions:\n  enabled: true\n  autoUpdate: false\n  models:\n    autoDownload: false\n`);
    const base = `http://127.0.0.1:${port}`, apiRoot = '/api/plugins/long-memory-bridge';
    child = spawn(process.execPath, ['server.js','--configPath',config,'--dataRoot',data,'--port',String(port),'--listen','false','--browserLaunchEnabled','false'], {
        cwd:host, windowsHide:true, stdio:['ignore','pipe','pipe'],
        env:{...process.env, NODE_ENV:'test', LONG_MEMORY_STATE_DIR:state, LONG_MEMORY_PYTHON:process.env.LONG_MEMORY_PYTHON || 'python',
            HF_HOME:checked(path.join(root,'hf')), TRANSFORMERS_CACHE:checked(path.join(root,'transformers'))},
    });
    const capture = chunk => {serverLog = (serverLog + chunk.toString()).slice(-300000);};
    child.stdout.on('data',capture); child.stderr.on('data',capture);
    let ready = false;
    for(let attempt=0;attempt<240;attempt++) {
        if(child.exitCode !== null) throw Error('Isolated host exited before readiness');
        try {const response=await fetch(base+'/csrf-token',{signal:AbortSignal.timeout(1500)});if(response.ok){ready=true;break;}} catch {}
        await wait(500);
    }
    assert.ok(ready, 'Isolated host must become ready within 120 seconds');
    pass('isolated tracked host starts with fresh config/data/state');
    const cookies = new Map(); let csrf;
    async function http(route, body, {noCsrf=false,status=200}={}) {
        const headers = {cookie:[...cookies].map(([key,value])=>key+'='+value).join('; ')};
        if(body !== undefined) {headers['content-type']='application/json';if(!noCsrf)headers['x-csrf-token']=csrf;}
        const response = await fetch(base+route,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(70000)});
        for(const cookie of response.headers.getSetCookie()) {const pair=cookie.split(';',1)[0], cut=pair.indexOf('=');cookies.set(pair.slice(0,cut),pair.slice(cut+1));}
        assert.equal(response.status,status,`HTTP status for ${route}`);
        const text=await response.text();return response.headers.get('content-type')?.includes('json')?JSON.parse(text):text;
    }
    csrf=(await http('/csrf-token')).token;
    assert.notEqual(csrf,'disabled');assert.ok(csrf && cookies.size);
    await http(apiRoot+'/put_batch',{world:'host-synthetic',chat:'host-chat',items:[]},{noCsrf:true,status:403});
    pass('real cookie session enforces CSRF for plugin routes');
    assert.equal((await http(apiRoot+'/status')).ready,true);
    const scope={world:'host-synthetic',chat:'host-chat'}, content='Synthetic fixture only. 漢字🙂 '.repeat(1100)+'UNIQUE_HOST_TAIL';
    const item={source:'synthetic-source',revision:1,role:'user',text:content};
    const ack=await http(apiRoot+'/put_batch',{...scope,items:[item]});
    assert.equal(ack.applied,1);assert.equal(ack.acknowledgments[0].sha256,digest(content));
    assert.ok((await http(apiRoot+'/item',{...scope,source:item.source})).item.body===content,'Full canonical item must equal synthetic source');
    pass('real plugin worker persists and reads full Unicode text with exact SHA-256 acknowledgment');
    const library={...scope,collection:'hosttest'}, raw='# Synthetic host document\n\nOnly invented facts. Unicode 世界🙂. needle-host-evidence';
    assert.equal((await http(apiRoot+'/library/preview',{...library,name:'host.md',raw})).messages,1);
    assert.equal((await http(apiRoot+'/library/import',{...library,name:'host.md',raw})).imported,1);
    const matches=(await http(apiRoot+'/library/search',{...library,query:'needle-host-evidence',mode:'exact'})).matches;
    assert.equal(matches.length,1);
    assert.equal((await http(apiRoot+'/library/read',{...library,...matches[0]})).item.text.includes('needle-host-evidence'),true);
    const exported=await http(apiRoot+'/library/export',library);
    assert.equal(exported.sha256,digest(JSON.stringify(exported.snapshot)));assert.equal(exported.snapshot.documents[0].raw,raw);
    const target={...library,collection:'restored'};
    assert.equal((await http(apiRoot+'/library/restore',{...target,archive:exported})).imported,1);
    assert.deepEqual((await http(apiRoot+'/library/export',target)).snapshot,exported.snapshot);
    const tampered=structuredClone(exported);tampered.snapshot.documents[0].raw+='tamper';
    await http(apiRoot+'/library/restore',{...target,archive:tampered},{status:400});
    assert.deepEqual((await http(apiRoot+'/library/export',target)).snapshot,exported.snapshot);
    pass('real HTTP preview/import/search/read/export/restore and tamper rejection preserve originals');
    const {write:writeCard}=await import(pathToFileURL(checked(path.join(host,'src','character-card-parser.js'))).href);
    const syntheticCard={name:'LongMemory Synthetic Host',description:'Invented smoke-test character; no model calls.',
        personality:'',scenario:'',first_mes:'Synthetic greeting only.',mes_example:'',chat:'Synthetic Host Chat',
        create_date:new Date().toISOString(),spec:'chara_card_v2',spec_version:'2.0',
        data:{name:'LongMemory Synthetic Host',description:'Invented smoke-test character.',personality:'',scenario:'',
            first_mes:'Synthetic greeting only.',mes_example:'',creator_notes:'Synthetic only.',system_prompt:'',
            post_history_instructions:'',alternate_greetings:[],tags:[],creator:'Synthetic smoke harness',character_version:'1',extensions:{}}};
    const cardPath=checked(path.join(data,'default-user','characters','LongMemory-Synthetic-Host.png'));
    await mkdir(path.dirname(cardPath),{recursive:true});
    await writeFile(cardPath,writeCard(await readFile(checked(path.join(host,'public','img','ai4.png'))),JSON.stringify(syntheticCard)));

    browser=await chromium.launch({headless:true});
    const context=await browser.newContext({viewport:{width:1440,height:1100},locale:'en-US'});
    await context.route('**/*',async route=>{
        const url=new URL(route.request().url());
        if(url.protocol==='http:'||url.protocol==='https:') {
            if(url.origin!==base){externalRequests.push(url.origin);return route.abort();}
            if(/\/api\/(?:backends\/.+\/generate|openai\/(?:generate|status)|novelai\/generate|textgenerationwebui\/generate)/.test(url.pathname)){providerRequests.push(url.pathname);return route.abort();}
        }
        return route.continue();
    });
    const page=await context.newPage();page.on('pageerror',error=>browserErrors.push(error.message));
    await page.goto(base,{waitUntil:'domcontentloaded',timeout:90000});
    await page.waitForSelector('#long_memory_settings',{state:'attached',timeout:90000});
    await page.waitForSelector('#long_memory_library',{state:'attached',timeout:15000});
    for(const selector of ['#long_memory_enabled','#long_memory_auto_import','#long_memory_auto_offload','#long_memory_library [data-k="inject"]'])assert.equal(await page.locator(selector).isChecked(),false,selector+' defaults off');
    pass('real host discovers and loads extension with capture/import/offload/injection defaults off');
    await page.locator('dialog[open] .popup-button-ok').click();
    await page.waitForFunction(async()=>{const script=await import('/script.js');return script.settingsReady;},{},{timeout:30000});
    const selected=await page.evaluate(async()=>{
        const script=await import('/script.js');
        await script.getCharacters();
        const id=script.characters.findIndex(value=>value.avatar==='LongMemory-Synthetic-Host.png');
        if(id<0)return false;await script.selectCharacterById(id);return true;
    });
    assert.ok(selected,'Synthetic character must load through real host context');
    const extensionScope=await page.evaluate(async()=>{
        const {getContext}=await import('/scripts/extensions.js');
        const {makeMemoryScope}=await import('/scripts/extensions/third-party/LongMemory/client.mjs');
        return makeMemoryScope(getContext());
    });
    assert.ok(extensionScope?.world&&extensionScope?.chat);
    await http(apiRoot+'/library/import',{...extensionScope,collection:'default',name:'browser.md',raw:'# Synthetic UI evidence\n\nBrowser needle-host-ui 世界🙂.'});
    await page.locator('#extensions-settings-button > .drawer-toggle').click();
    await page.locator('#long_memory_library > summary').click();
    await page.locator('#long_memory_library [data-k="query"]').fill('needle-host-ui');
    await page.locator('#long_memory_library [data-k="search"]').click();
    await page.waitForSelector('#long_memory_library article',{timeout:15000});
    assert.match(await page.locator('#long_memory_library article').innerText(),/needle-host-ui/);
    assert.equal(providerRequests.length,0,'Smoke must not issue provider requests');
    const screenshot=path.resolve(process.env.ST_SCREENSHOT || path.join(evidence,'LongMemory-v0.3.0-host.png'));
    assert.ok(path.relative(project,screenshot) && !path.relative(project,screenshot).startsWith('..'),'Screenshot must stay in workspace');
    await mkdir(path.dirname(screenshot),{recursive:true});
    await page.waitForFunction(()=>document.querySelectorAll('#toast-container .toast').length===0,{},{timeout:15000});
    await page.locator('#long_memory_library').scrollIntoViewIfNeeded();await page.screenshot({path:screenshot,fullPage:true});
    results.screenshot=screenshot;results.browserPageErrors=browserErrors;results.blockedExternalOrigins=[...new Set(externalRequests)];
    pass('real synthetic character context searches imported knowledge in installed UI without model calls');
    successful=true;
} catch(error) {
    results.failure=error.message;results.browserPageErrors=browserErrors;
    await writeFile(path.join(evidence,'host-smoke-server-failure.log'),serverLog);
    throw error;
} finally {
    await browser?.close();
    if(child&&child.exitCode===null) {
        if(process.platform==='win32')await execFile('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true}).catch(()=>{});
        else {child.kill('SIGTERM');await wait(1500);if(child.exitCode===null)child.kill('SIGKILL');}
    }
    results.passed=successful;await writeFile(path.join(evidence,'host-smoke-result.json'),JSON.stringify(results,null,2)+'\n');
    try {await unlink(checked(junction));} catch(error) {if(error.code!=='ENOENT')throw error;}
    await rm(checked(root),{recursive:true,force:true});
}
