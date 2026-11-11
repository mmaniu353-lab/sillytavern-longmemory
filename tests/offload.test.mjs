import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { createHash, webcrypto } from 'node:crypto';
import * as client from '../extension/client.mjs';
import * as orchestrator from '../extension/orchestrator.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const ack = value => ({ source: value.source, revision: value.revision, sha256: hash(value.text), status: 'stored' });
const message = (mes, id) => ({ mes, is_system: false, extra: { long_memory_bridge: { source: id, revision: 1, pinned: false, offloaded: false } } });

async function host({ transport, save = async () => {}, tokenCount = async () => 1, preference = { enabled: true, autoImportHistory: false, autoOffloadOverflow: false, maxActiveFloors: 2 } } = {}) {
    const chat = [message('汉🙂'.repeat(7000), 'a'), message('second', 'b'), message('third', 'c'), message('fourth', 'd')];
    let context = { chatId: 'chat-a', characterId: 0, characters: [{ avatar: 'hero.png' }], chat, saveChat: async () => { calls.save++; return save(); } };
    const calls = { save: 0, writes: [], status: [], transitions: [], prompts: [] };
    const visible = new Map(chat.map((_, index) => [index, 'false']));
    const sandbox = { ...client, ...orchestrator, console, crypto: webcrypto, setTimeout, clearTimeout, AbortController,
        extension_settings: { long_memory_bridge: preference },
        getContext: () => context, getRequestHeaders: () => ({}), saveSettingsDebounced() {}, setExtensionPrompt: (_, prompt) => calls.prompts.push(prompt), extension_prompt_types: { IN_PROMPT: 1 }, getTokenCountAsync: tokenCount,
        document: { readyState: 'loading', addEventListener() {}, getElementById: () => null, querySelector: selector => { const index = Number(selector.match(/mesid="(\d+)"/)[1]); return { setAttribute: (_, value) => visible.set(index, value), getAttribute: () => visible.get(index), removeAttribute: () => visible.delete(index) }; } },
        fetch: async (url, options) => { const body = JSON.parse(options.body); calls.writes.push({ url, body }); const result = transport ? await transport(body) : url.endsWith('/put_batch') ? { acknowledgments: body.items.map(ack), applied: body.items.length } : { status: ack(body) }; return { ok: true, json: async () => result }; }
    };
    let source = await fs.readFile(new URL('../extension/index.js', import.meta.url), 'utf8');
    source = source.replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];\s*/gm, '');
    const persistence = await import('../extension/persistence.mjs').catch(() => ({}));
    Object.assign(sandbox, persistence);
    vm.createContext(sandbox);
    vm.runInContext(source + '\n;globalThis.hostExports={offloadOverflowFloors,toggleFloorState,restoreOffloadedFloors,rememberAt,settings,buildPartitionModel,api,observabilityRuntime,intercept:globalThis.longMemoryGenerationInterceptor}; recordTransition = value => calls.transitions.push(value); refreshObservabilitySnapshot = async () => {}; showStatus = message => calls.status.push(message);', Object.assign(sandbox, { calls }));
    return { ...sandbox.hostExports, sandbox, source, chat, calls, visible, switchChat: () => { context = { ...context, chatId: 'chat-b', chat: [] }; } };
}

test('actual overflow path refuses rejected, partial, stale, wrong-hash and missing acknowledgments without hiding/saving', async () => {
    for (const transport of [async () => { throw new Error('timeout'); }, async () => ({ applied: 1, acknowledgments: [] }), async body => ({ applied: body.items.length, acknowledgments: body.items.map(value => ({ ...ack(value), sha256: '0'.repeat(64) })) }), async body => ({ applied: body.items.length, acknowledgments: body.items.map(value => ({ ...ack(value), revision: 0 })) })]) {
        const h = await host({ transport });
        await assert.rejects(() => h.offloadOverflowFloors({ keepFloors: 2 }));
        assert.equal(h.calls.save, 0);
        assert.ok(h.chat.every(value => !value.is_system && !value.extra.long_memory_bridge.offloaded));
        assert.ok([...h.visible.values()].every(value => value === 'false'));
    }
});

test('actual overflow persists complete text and only hides after verified acknowledgment', async () => {
    const h = await host();
    assert.equal(await h.offloadOverflowFloors({ keepFloors: 2 }), 2);
    assert.equal(h.calls.writes[0].body.items[0].text, h.chat[0].mes);
    assert.ok(h.chat[0].is_system);
    assert.equal(h.calls.save, 1);
});

test('actual overflow rejects concurrent content edit and chat switch during persistence', async () => {
    for (const change of ['edit', 'switch']) {
        let h;
        h = await host({ transport: async body => { if (change === 'edit') h.chat[0].mes += 'edited'; else h.switchChat(); return { applied: body.items.length, acknowledgments: body.items.map(ack) }; } });
        await assert.rejects(() => h.offloadOverflowFloors({ keepFloors: 2 }), /changed/);
        assert.equal(h.calls.save, 0);
        assert.ok(h.chat.every(value => !value.is_system));
    }
});

test('actual overflow rolls back flags and exact DOM visibility on save failure', async () => {
    const h = await host({ save: async () => { throw new Error('disk full'); } });
    h.visible.set(0, 'custom');
    const before = JSON.stringify(h.chat);
    await assert.rejects(() => h.offloadOverflowFloors({ keepFloors: 2 }), /disk full/);
    assert.equal(JSON.stringify(h.chat), before);
    assert.equal(h.visible.get(0), 'custom');
    assert.equal(h.calls.transitions.length, 0);
});

test('actual manual offload preserves visibility on missing ack and restore rolls back on save failure', async () => {
    const h = await host({ transport: async () => ({ status: 'stored' }) });
    await assert.rejects(() => h.toggleFloorState(0, 'offload'));
    assert.equal(h.chat[0].is_system, false);
    assert.equal(h.calls.save, 0);
    const restoring = await host({ save: async () => { throw new Error('save failed'); } });
    restoring.chat[0].is_system = true;
    restoring.chat[0].extra.long_memory_bridge.offloaded = true;
    restoring.visible.set(0, 'true');
    await assert.rejects(() => restoring.restoreOffloadedFloors(), /save failed/);
    assert.equal(restoring.chat[0].is_system, true);
    assert.equal(restoring.chat[0].extra.long_memory_bridge.offloaded, true);
    assert.equal(restoring.visible.get(0), 'true');
});

test('remember success is announced only after acknowledged full-content write', async () => {
    const h = await host({ transport: async () => { throw new Error('timeout'); } });
    await assert.rejects(() => h.rememberAt(0));
    assert.equal(h.calls.transitions.length, 0);
    assert.equal(h.calls.save, 0);
});


test('no visibility or flag changes occur while acknowledgment is pending', async () => {
    let complete;
    const h = await host({ transport: body => new Promise(resolve => { complete = () => resolve({ applied: body.items.length, acknowledgments: body.items.map(ack) }); }) });
    const operation = h.offloadOverflowFloors({ keepFloors: 2 });
    assert.ok(h.chat.every(value => !value.is_system));
    assert.equal(h.calls.save, 0);
    complete();
    await operation;
    assert.equal(h.calls.save, 1);
});

test('initial defaults opt out but explicit existing preferences remain enabled', async () => {
    const fresh = await host({ preference: null });
    assert.equal(fresh.settings().enabled, false);
    assert.equal(fresh.settings().autoImportHistory, false);
    assert.equal(fresh.settings().autoOffloadOverflow, false);
    const existing = await host({ preference: { enabled: true, autoImportHistory: true, autoOffloadOverflow: true } });
    assert.equal(existing.settings().enabled, true);
    assert.equal(existing.settings().autoImportHistory, true);
    assert.equal(existing.settings().autoOffloadOverflow, true);
});

test('cross-chat snapshot nodes remain distinct and carry opaque itemChat for retrieval', async () => {
    const h = await host({ transport: async body => ({ item: { body: body.itemChat } }) });
    h.observabilityRuntime.dbSnapshot.nodes = [
        { chat: 'a'.repeat(64), source: 'shared', preview: 'one' },
        { chat: 'b'.repeat(64), source: 'shared', preview: 'two' },
    ];
    const nodes = h.buildPartitionModel().filter(node => node.source === 'shared');
    assert.equal(nodes.length, 2);
    assert.notEqual(nodes[0].key, nodes[1].key);
    assert.equal(nodes[0].itemChat, 'a'.repeat(64));
    await h.api.getItem({ world: 'w', chat: 'current' }, 'shared', nodes[0].itemChat);
    assert.equal(h.calls.writes[0].body.itemChat, 'a'.repeat(64));
});

test('actual manual offload and restore each roll back exact flags and DOM on failed save', async () => {
    const h = await host({ save: async () => { throw new Error('save failed'); } });
    const before = JSON.stringify(h.chat);
    h.visible.set(0, 'custom-visible');
    await assert.rejects(() => h.toggleFloorState(0, 'offload'), /save failed/);
    assert.equal(JSON.stringify(h.chat), before);
    assert.equal(h.visible.get(0), 'custom-visible');
});


test('remember full-content success saves revision only after ack and rolls back failed chat save', async () => {
    let complete;
    const h = await host({ transport: body => new Promise(resolve => { complete = () => resolve({ acknowledgments: body.items.map(ack), applied: body.items.length }); }) });
    const before = h.chat[0].extra.long_memory_bridge.revision;
    const operation = h.rememberAt(0);
    while (!complete) await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(h.chat[0].extra.long_memory_bridge.revision, before);
    assert.equal(h.calls.save, 0);
    assert.equal(h.calls.transitions.length, 0);
    complete();
    await operation;
    assert.equal(h.calls.save, 1);
    assert.equal(h.calls.transitions.length, 1);
    assert.equal(h.calls.writes[0].body.items[0].text, h.chat[0].mes);
    const failed = await host({ save: async () => { throw new Error('chat save failed'); } });
    await assert.rejects(() => failed.rememberAt(0), /chat save failed/);
    assert.equal(failed.chat[0].extra.long_memory_bridge.revision, 1);
    assert.equal(failed.calls.transitions.length, 0);
});


test('chat switch while token counting cannot inject old chat recalled evidence', async () => {
    let h;
    h = await host({ tokenCount: async () => { h.switchChat(); return 1; }, transport: async body => {
        if ('items' in body) return { acknowledgments: body.items.map(ack), applied: body.items.length };
        if ('query' in body) return { matches: [{ chat: 'a'.repeat(64), source: 'memory', text: 'private old chat evidence' }] };
        if ('presentSources' in body) return { removed: 0 };
        return { revisions: {} };
    } });
    await h.intercept(h.chat, 8192, () => {});
    assert.ok(h.calls.prompts.every(prompt => !prompt));
});

test('late content or role edits during chat save reject offload and preserve edited content visibly', async () => {
    for (const change of ['text', 'role']) {
        let h;
        h = await host({ save: async () => { if (change === 'text') h.chat[0].mes = 'new content after acknowledgment'; else h.chat[0].is_user = true; } });
        await assert.rejects(() => h.offloadOverflowFloors({ keepFloors: 2 }), /changed/);
        assert.equal(h.chat[0].is_system, false); assert.equal(h.chat[0].extra.long_memory_bridge.offloaded, false);
        assert.equal(h.visible.get(0), 'false'); assert.equal(h.calls.transitions.length, 0);
        if (change === 'text') assert.equal(h.chat[0].mes, 'new content after acknowledgment'); else assert.equal(h.chat[0].is_user, true);
    }
});

test('failed save rollback preserves concurrent tag revisions and unrelated metadata', async () => {
    let h;
    h = await host({ save: async () => { const tag = h.chat[0].extra.long_memory_bridge; tag.revision = 77; tag.newerMetadata = 'keep'; throw new Error('save failed'); } });
    await assert.rejects(() => h.offloadOverflowFloors({ keepFloors: 2 }), /save failed/);
    assert.equal(h.chat[0].extra.long_memory_bridge.revision, 77);
    assert.equal(h.chat[0].extra.long_memory_bridge.newerMetadata, 'keep');
    assert.equal(h.chat[0].extra.long_memory_bridge.offloaded, false); assert.equal(h.chat[0].is_system, false);
});

test('deferred save chat switch rejects success without changing new chat DOM or resaving wrong scope', async () => {
    let release; const h = await host({ save: () => new Promise(resolve => { release = resolve; }) });
    const operation = h.offloadOverflowFloors({ keepFloors: 2 });
    while (!release) await new Promise(resolve => setTimeout(resolve, 0));
    h.switchChat(); h.visible.set(0, 'new-chat-visible'); release();
    await assert.rejects(() => operation, /changed/);
    assert.equal(h.chat[0].is_system, false); assert.equal(h.chat[0].extra.long_memory_bridge.offloaded, false);
    assert.equal(h.visible.get(0), 'new-chat-visible'); assert.equal(h.calls.save, 1); assert.equal(h.calls.transitions.length, 0);
});

test('late tag revision edit during successful save remains preserved while offload visibility rolls back', async () => {
    let release; const h = await host({ save: async () => { if (!release) await new Promise(resolve => { release = resolve; }); } });
    const operation = h.toggleFloorState(0, 'offload');
    while (!release) await new Promise(resolve => setTimeout(resolve, 0));
    h.chat[0].extra.long_memory_bridge.revision = 88; h.chat[0].extra.long_memory_bridge.note = 'newer'; release();
    await assert.rejects(() => operation, /changed/);
    assert.equal(h.chat[0].extra.long_memory_bridge.revision, 88); assert.equal(h.chat[0].extra.long_memory_bridge.note, 'newer');
    assert.equal(h.chat[0].is_system, false); assert.equal(h.calls.transitions.length, 0);
});

test('replacement tag object keeps newer revision but rolls back owned offload flags', async () => {
    let h; h = await host({ save: async () => { const msg = h.chat[0]; msg.extra.long_memory_bridge = { ...msg.extra.long_memory_bridge, revision: 99, concurrent: 'keep' }; } });
    await assert.rejects(() => h.toggleFloorState(0, 'offload'), /changed/);
    assert.equal(h.chat[0].extra.long_memory_bridge.revision, 99); assert.equal(h.chat[0].extra.long_memory_bridge.concurrent, 'keep');
    assert.equal(h.chat[0].extra.long_memory_bridge.offloaded, false); assert.equal(h.chat[0].is_system, false);
});

test('late content guard performs at most one compensating save and stays visible if that save fails', async () => {
    let h; h = await host({ save: async () => { if (h.calls.save === 1) h.chat[0].mes = 'late edit'; else throw new Error('rollback disk error'); } });
    await assert.rejects(() => h.offloadOverflowFloors({ keepFloors: 2 }), /memory_rollback_save_failed_keep_visible/);
    assert.equal(h.calls.save, 2); assert.equal(h.chat[0].mes, 'late edit'); assert.equal(h.chat[0].is_system, false);
    assert.equal(h.chat[0].extra.long_memory_bridge.offloaded, false); assert.equal(h.calls.transitions.length, 0);
});


test('actual settings offload callback catches backend failure and shows no private error content', async () => {
    const h = await host({ transport: async () => { throw new Error('PRIVATE_BACKEND_DETAIL'); } });
    h.settings().maxActiveFloors = 4; h.chat.push(message('fifth', 'e'), message('sixth', 'f'));
    const match = h.source.match(/panel\.querySelector\('#long_memory_offload_btn'\)\.addEventListener\('click', (manualAction\([\s\S]*?\))\);/);
    assert.ok(match, 'settings callback must be guarded by manualAction');
    vm.runInContext('globalThis.manualCallback = ' + match[1], h.sandbox);
    await h.sandbox.manualCallback();
    assert.equal(h.calls.save, 0); assert.equal(h.chat[0].is_system, false);
    assert.match(h.calls.status.at(-1), /操作未完成/); assert.match(h.calls.status.at(-1), /原文/);
    assert.doesNotMatch(h.calls.status.at(-1), /PRIVATE_BACKEND_DETAIL/);
    for (const id of ['lm_btn_offload_now', 'lm_btn_restore_all', 'long_memory_restore_btn']) {
        assert.ok(new RegExp("(?:querySelector|[Gg]etElementById)\\('" + (id.startsWith('long_') ? '#' : '') + id + "'\\)\\.addEventListener\\('click', manualAction").test(h.source), id);
    }
});


test('manual callback explicitly surfaces compensating save failure without claiming durable rollback', async () => {
    let h; h = await host({ save: async () => { if (h.calls.save === 1) h.chat[0].mes = 'late edit'; else throw new Error('PRIVATE_DISK_ERROR'); } });
    h.settings().maxActiveFloors = 4; h.chat.push(message('fifth', 'e'), message('sixth', 'f'));
    const callback = h.source.match(/panel\.querySelector\('#long_memory_offload_btn'\)\.addEventListener\('click', (manualAction\([\s\S]*?\))\);/)[1];
    vm.runInContext('globalThis.manualCallback = ' + callback, h.sandbox); await h.sandbox.manualCallback();
    assert.match(h.calls.status.at(-1), /回滚保存失败/); assert.match(h.calls.status.at(-1), /请勿切换或重载/);
    assert.doesNotMatch(h.calls.status.at(-1), /PRIVATE_DISK_ERROR/); assert.equal(h.calls.transitions.length, 0);
});
