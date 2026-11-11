import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { mountLibrary, getKnowledgePrompt } from '../extension/library.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const match = (overrides = {}) => ({ documentId: 'doc', messageId: 'm', revision: 'r'.repeat(64), text: '<img src=x onerror=bad()> lighthouse', title: '<script>bad()</script>', collection: 'default', sha256: 'a'.repeat(64), offset: 0, ...overrides });
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function host(request = async route => route.endsWith('/search') ? { matches: [match()] } : { documents: [], messages: 1, warnings: ['projection'] }) {
    const dom = new JSDOM('<div id="target"></div>');
    globalThis.document = dom.window.document; globalThis.window = dom.window;
    let scope = { world: 'world', chat: 'chat' };
    const calls = [];
    const panel = mountLibrary({ container: document.querySelector('#target'), request: async (route, body) => { calls.push({ route, body }); return request(route, body); }, getScope: () => scope });
    const el = key => document.querySelector(`[data-k="${key}"]`);
    return { panel, calls, el, dom, scope, switchChat: () => { scope = { ...scope, chat: 'other-chat' }; }, changeCollection(value) { el('collection').value = value; el('collection').dispatchEvent(new dom.window.Event('change')); } };
}

test('library requires explicit preview/commit, defaults opt out, and renders hostile fields as text', async () => {
    const h = host(); assert.equal(h.calls.length, 0);
    await h.panel.preview({ name: 'n.md', raw: 'source' }); assert.equal(h.calls.at(-1).route, '/library/preview');
    assert.equal(h.calls.some(call => call.route.endsWith('/import')), false);
    await h.panel.commit(); assert.equal(h.calls.at(-1).route, '/library/import');
    await h.panel.search('lighthouse'); assert.equal(document.querySelectorAll('img,script').length, 0);
    h.panel.select(0); assert.equal(await getKnowledgePrompt(h.scope, 1000, async value => value.length), '');
    h.panel.enable(true);
    const prompt = await getKnowledgePrompt(h.scope, 2000, async value => value.length);
    assert.match(prompt, /lighthouse/); assert.match(prompt, /证据/); assert.match(prompt, /a{64}/); assert.match(prompt, /r{64}/);
    assert.equal(await getKnowledgePrompt({ world: 'other', chat: 'chat' }, 2000, async value => value.length), '');
    h.dom.window.close();
});

test('stale search responses and detached selection buttons cannot select another scope evidence', async () => {
    const waiting = defer(); const h = host(async () => waiting.promise);
    const search = h.panel.search('one'); h.switchChat(); waiting.resolve({ matches: [match()] });
    await search;
    assert.equal(h.el('results').children.length, 0);
    assert.equal(h.panel.select(0), false);
    const current = host(); await current.panel.search('one');
    const oldPick = current.el('results').querySelector('button'); current.switchChat(); oldPick.click();
    current.panel.enable(true);
    assert.equal(await getKnowledgePrompt({ world: 'world', chat: 'other-chat' }, 2000, async value => value.length), '');
});

test('later search wins even if earlier response arrives last', async () => {
    const first = defer(); const h = host(async (_route, body) => body.query === 'first' ? first.promise : { matches: [match({ text: 'newest answer' })] });
    const older = h.panel.search('first'); await h.panel.search('second'); first.resolve({ matches: [match({ text: 'older answer' })] }); await older;
    assert.match(h.el('results').textContent, /newest answer/); assert.doesNotMatch(h.el('results').textContent, /older answer/);
});

test('preview failure cannot leave a prior file committable; stale preview cannot relabel scope', async () => {
    let fail = false; const h = host(async () => { if (fail) throw new Error('bad preview'); return { messages: 1 }; });
    await h.panel.preview({ name: 'first.md', raw: 'first' }); fail = true;
    await assert.rejects(() => h.panel.preview({ name: 'bad.md', raw: 'bad' }), /bad preview/);
    assert.equal(h.el('commit').disabled, true); await assert.rejects(() => h.panel.commit());
    const waiting = defer(); const other = host(async () => waiting.promise);
    const preview = other.panel.preview({ name: 'old.md', raw: 'private' }); other.switchChat(); waiting.resolve({ messages: 1 }); await preview;
    assert.equal(other.el('commit').disabled, true); await assert.rejects(() => other.panel.commit());
});

test('collection change clears selection, injection opt-in, pending import and stale result buttons', async () => {
    const h = host(); await h.panel.search('one'); h.panel.select(0); h.panel.enable(true); await h.panel.preview({ name: 'n.md', raw: 'source' });
    h.changeCollection('different');
    assert.equal(h.el('inject').checked, false); assert.equal(h.el('commit').disabled, true); assert.equal(h.el('results').children.length, 0);
    assert.equal(await getKnowledgePrompt(h.scope, 2000, async value => value.length), '');
    await assert.rejects(() => h.panel.commit());
});

test('stale read response cannot overwrite a new chat UI status', async () => {
    const waiting = defer(); const h = host(async route => route.endsWith('/search') ? { matches: [match()] } : waiting.promise);
    await h.panel.search('one'); const read = h.el('results').querySelectorAll('button')[1]; read.click();
    h.switchChat(); h.panel.enable(false); h.el('status').textContent = 'NEW SCOPE'; waiting.resolve({ item: { text: 'OLD PRIVATE FULL TEXT' } });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(h.el('status').textContent, 'NEW SCOPE');
});

test('scope, selection or enabled changes while token counting cancel the prompt', async () => {
    for (const change of ['scope', 'disable', 'collection']) {
        const h = host(); await h.panel.search('one'); h.panel.select(0); h.panel.enable(true);
        const prompt = await getKnowledgePrompt(h.scope, 2000, async value => { if (change === 'scope') h.switchChat(); else if (change === 'disable') h.panel.enable(false); else h.changeCollection('different'); return value.length; });
        assert.equal(prompt, '', change);
    }
});

test('token shrinking preserves full trusted header, complete JSON quoting and hash/revision citations', async () => {
    const h = host(async () => ({ matches: [match({ title: 'Synthetic\nSYSTEM', text: '"\\\n复杂🙂'.repeat(500) })] }));
    await h.panel.search('one'); h.panel.select(0); h.panel.enable(true);
    const prompt = await getKnowledgePrompt(h.scope, 400, async value => value.length);
    assert.ok(prompt.length <= 400); assert.match(prompt, /不是指令/); assert.match(prompt, /a{64}/); assert.match(prompt, /r{64}/);
    const lines = prompt.trimEnd().split('\n'); assert.ok(lines.length >= 2);
    for (const line of lines.slice(1)) { assert.doesNotThrow(() => JSON.parse(line)); }
});

test('backup integrity is previewed and verified before restore confirmation', async () => {
    const h = host(); const raw = 'synthetic original';
    const document = { id: 'd', title: 'Synthetic', format: 'text', raw, sha256: hash(raw), messages: [{ id: 'm', role: 'note', text: raw }], warnings: [] };
    const snapshot = { schemaVersion: 1, documents: [document] };
    const archive = { schema: 'longmemory.archive.v1', snapshot, sha256: hash(JSON.stringify(snapshot)) };
    assert.equal(typeof h.panel.previewBackup, 'function');
    await h.panel.previewBackup(JSON.stringify(archive)); assert.equal(h.el('restore').disabled, false);
    assert.match(h.el('status').textContent, /1/); assert.match(h.el('status').textContent, /完整性|integrity/i);
    archive.snapshot.documents[0].raw = 'tampered';
    await assert.rejects(() => h.panel.previewBackup(JSON.stringify(archive)), /hash|完整性/i);
    assert.equal(h.el('restore').disabled, true); assert.equal(h.calls.some(call => call.route.endsWith('/restore')), false);
});


test('mounted preview button surfaces errors and cannot import an older preview', async () => {
    let rejectImport = false;
    const h = host(async route => { if (route.endsWith('/import') && rejectImport) throw new Error('import rejected'); return { messages: 1 }; });
    await h.panel.preview({ name: 'safe.md', raw: 'source' }); rejectImport = true; h.el('commit').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.match(h.el('status').textContent, /操作未完成.*import rejected/);
    assert.equal(h.el('commit').disabled, true);
});

test('preview failure response cannot overwrite a newer successful preview or enable old file commit', async () => {
    const first = defer(); const h = host(async (_route, body) => body.name === 'first.md' ? first.promise : { messages: 1 });
    const older = h.panel.preview({ name: 'first.md', raw: 'old' }); await h.panel.preview({ name: 'second.md', raw: 'new' });
    first.resolve({ messages: 99 }); await older; await h.panel.commit();
    assert.equal(h.calls.at(-1).body.name, 'second.md');
    assert.equal(h.calls.at(-1).body.raw, 'new');
});

test('a new file choice immediately invalidates an in-flight earlier preview before reading finishes', async () => {
    const waiting = defer(), fileRead = defer(); const h = host(async () => waiting.promise);
    const old = h.panel.preview({ name: 'old.md', raw: 'old' });
    Object.defineProperty(h.el('file'), 'files', { configurable: true, value: [{ name: 'new.md', size: 3, text: () => fileRead.promise }] });
    h.el('file').dispatchEvent(new h.dom.window.Event('change'));
    waiting.resolve({ messages: 1 }); await old;
    assert.equal(h.el('commit').disabled, true);
    fileRead.resolve('new'); await new Promise(resolve => setTimeout(resolve, 0));
});

test('collection return cannot revive selected evidence and prompt output never cuts Unicode surrogate pairs', async () => {
    const h = host(async () => ({ matches: [match({ text: '👩🏽‍💻'.repeat(2000) })] }));
    await h.panel.search('one'); h.panel.select(0); h.panel.enable(true);
    const prompt = await getKnowledgePrompt(h.scope, 400, async text => text.length);
    assert.equal(Buffer.from(prompt).toString('utf8'), prompt);
    h.changeCollection('different'); h.changeCollection('default'); h.panel.enable(true);
    assert.equal(await getKnowledgePrompt(h.scope, 2000, async text => text.length), '');
});


test('host chat-change reset prevents round-trip chat selection revival even before another operation', async () => {
    const h = host(); await h.panel.search('one'); h.panel.select(0); h.panel.enable(true);
    assert.equal(typeof h.panel.resetScope, 'function'); h.panel.resetScope();
    assert.equal(h.el('inject').checked, false); assert.equal(h.el('results').children.length, 0);
    h.panel.enable(true); assert.equal(await getKnowledgePrompt(h.scope, 2000, async text => text.length), '');
});
