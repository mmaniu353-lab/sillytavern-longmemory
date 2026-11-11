import {
    eventSource,
    event_types,
    extension_prompt_types,
    getRequestHeaders,
    saveSettingsDebounced,
    setExtensionPrompt,
} from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { getTokenCountAsync } from '../../../tokenizers.js';
import { activeWindowSources, fitPrompt, makeMemoryScope, nextRevision } from './client.mjs';
import { syncTagged } from './orchestrator.mjs';
import { persistItems } from './persistence.mjs';
import { mountLibrary, getKnowledgePrompt } from './library.mjs';

const PROMPT_KEY = 'long_memory_bridge_v1';
const API_ROOT = '/api/plugins/long-memory-bridge';
let pending = Promise.resolve();
let bypassOnce = false;
let archiveKey = '';
let archiveCurrentTarget;
let archiveTicket = 0;
let archiveTimer;
let libraryUI;

// High-Performance Event-Driven State-Space Runtime (0% idle CPU)
const observabilityRuntime = {
    lastRecalledMatches: [],
    lastQuery: '',
    dbSnapshot: {
        world_total_nodes: 0,
        world_total_chars: 0,
        chat_total_nodes: 0,
        chat_total_chars: 0,
        nodes: [],
        edges: [],
    },
    itemCache: new Map(), // Lazy-loaded full text cache for archived nodes
    transitions: [],
    particles: [],
    selectedNodeKey: null,
    renderedNodes: [],
    overflowCounts: { WINDOW: 0, VAULT: 0, RECALLED: 0, PINNED: 0 },
    rafId: null,
    bgCanvas: null,
    bgWidth: 0,
    bgHeight: 0,
};

const STATE_NAMES = {
    WINDOW: '当前聊天',
    VAULT: '记忆库',
    RECALLED: '本轮引用',
    PINNED: '重点置顶',
};

function recordTransition({ type, fromState, toState, source, floorIndex, role, charLen, detail }) {
    const entry = {
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        timestamp: new Date().toLocaleTimeString(),
        type,
        fromState,
        toState,
        source: String(source || '').slice(0, 24),
        floorIndex,
        role: role || 'assistant',
        charLen: Number(charLen || 0),
        detail: detail || '',
    };
    observabilityRuntime.transitions.unshift(entry);
    if (observabilityRuntime.transitions.length > 60) {
        observabilityRuntime.transitions.length = 60;
    }
    spawnTransitionParticle(fromState, toState, type);
    renderTransitionLedger();
    updatePillBadge();
}

function settings() {
    extension_settings.long_memory_bridge ??= {
        enabled: false,
        worldOverride: '',
        autoImportHistory: false,
        autoOffloadOverflow: false,
        maxActiveFloors: 24,
    };
    const cfg = extension_settings.long_memory_bridge;
    if (typeof cfg.enabled !== 'boolean') cfg.enabled = false;
    if (typeof cfg.autoImportHistory !== 'boolean') cfg.autoImportHistory = false;
    if (typeof cfg.autoOffloadOverflow !== 'boolean') cfg.autoOffloadOverflow = false;
    if (!Number.isFinite(cfg.maxActiveFloors) || cfg.maxActiveFloors < 4) cfg.maxActiveFloors = 24;
    return cfg;
}

function clearPrompt() {
    setExtensionPrompt(PROMPT_KEY, '', extension_prompt_types.IN_PROMPT, 0, false);
}

function showStatus(message, kind = 'normal') {
    const element = document.getElementById('long_memory_status');
    if (!element) return;
    element.textContent = message;
    element.dataset.state = kind;
}

function manualAction(action) {
    return async (...args) => {
        try { return await action(...args); } catch (error) {
            showStatus(error?.message === 'memory_rollback_save_failed_keep_visible'
                ? '操作未完成，原文已在当前窗口恢复；聊天回滚保存失败，请勿切换或重载，先另存原文并重试保存。'
                : '操作未完成；未确认的原文不会收起，当前窗口状态已回退。请检查记忆库连接并重试。', 'error');
        }
    };
}

function showArchiveStatus(message, kind = 'normal') {
    const element = document.getElementById('long_memory_archive_status');
    if (!element) return;
    element.textContent = message;
    element.dataset.state = kind;
}

async function request(route, body = undefined) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
        const response = await fetch(API_ROOT + route, {
            method: body === undefined ? 'GET' : 'POST',
            headers: getRequestHeaders(),
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: controller.signal,
        });
        if (!response.ok) throw new Error(`memory_http_${response.status}`);
        return await response.json();
    } finally {
        clearTimeout(timeout);
    }
}

const api = {
    async manifest(scope) {
        return (await request('/manifest', scope)).revisions;
    },
    async reconcile(scope, sources) {
        return (await request('/reconcile', { ...scope, presentSources: sources })).removed;
    },
    async put(scope, item) {
        return (await request('/put', { ...scope, ...item })).status;
    },
    async putBatch(scope, items) {
        return await request('/put_batch', { ...scope, items });
    },
    async recall(scope, query, excludeSources = []) {
        return (await request('/recall', { ...scope, query, excludeSources })).matches;
    },
    async inspect(scope, limit = 40) {
        return await request('/inspect', { ...scope, limit });
    },
    async getItem(scope, source, itemChat) {
        try {
            return (await request('/item', { ...scope, source, ...(itemChat ? { itemChat } : {}) })).item;
        } catch (err) {
            if (String(err?.message || '').includes('404')) return null;
            throw err;
        }
    },
};

function ensureMessageTag(message) {
    if (!message || typeof message.mes !== 'string' || !message.mes.trim()) return null;
    message.extra ??= {};
    if (!message.extra.long_memory_bridge || typeof message.extra.long_memory_bridge.source !== 'string') {
        message.extra.long_memory_bridge = {
            source: crypto.randomUUID(),
            revision: nextRevision(0),
            offloaded: false,
            pinned: false,
        };
    }
    return message.extra.long_memory_bridge;
}

function syncFloorDomVisibility(floorIndex, isHidden) {
    const mesEl = document.querySelector(`.mes[mesid="${floorIndex}"]`);
    if (mesEl) {
        mesEl.setAttribute('is_system', isHidden ? 'true' : 'false');
    }
}

function captureFloors(context, indices) {
    return indices.map(index => {
        const message = context.chat[index];
        const element = document.querySelector(`.mes[mesid="${index}"]`);
        return { index, message, text: message.mes, role: message.is_user ? 'user' : 'assistant',
            extra: message.extra, tag: message.extra?.long_memory_bridge,
            tagState: message.extra?.long_memory_bridge ? { ...message.extra.long_memory_bridge } : null,
            isSystem: message.is_system, domVisibility: element?.getAttribute('is_system') ?? null,
            proposed: message.extra?.long_memory_bridge ? { ...message.extra.long_memory_bridge } : {
                source: crypto.randomUUID(), revision: nextRevision(0), offloaded: false, pinned: false,
            } };
    });
}

function assertFloorsCurrent(context, scope, floors) {
    const current = getContext();
    const currentScope = makeMemoryScope(current, settings().worldOverride);
    if (current.chat !== context.chat || !currentScope || currentScope.chat !== scope.chat || currentScope.world !== scope.world ||
        floors.some(floor => context.chat[floor.index] !== floor.message || floor.message.mes !== floor.text ||
            (floor.message.is_user ? 'user' : 'assistant') !== floor.role || floor.message.is_system !== floor.isSystem ||
            floor.message.extra?.long_memory_bridge !== floor.tag ||
            JSON.stringify(floor.message.extra?.long_memory_bridge ?? null) !== JSON.stringify(floor.tagState))) {
        throw new Error('memory_context_or_message_changed');
    }
}

function rollbackFloors(floors) {
    for (const floor of floors) {
        const applied = floor.applied;
        if (!applied) continue;
        const tag = floor.message.extra?.long_memory_bridge;
        if (tag && (tag === applied.tag || tag.source === applied.tagState.source)) {
            const unchanged = tag === applied.tag && JSON.stringify(tag) === JSON.stringify(applied.tagState);
            if (!floor.tag && unchanged) {
                delete floor.message.extra.long_memory_bridge;
                if (!floor.extra && !Object.keys(floor.message.extra).length) delete floor.message.extra;
            } else {
                const old = floor.tagState || {};
                const keys = floor.tag ? new Set([...Object.keys(old), ...Object.keys(applied.tagState)]) :
                    new Set(['offloaded', 'offloadedAt', 'pinned']);
                for (const key of keys) {
                    if (!Object.is(old[key], applied.tagState[key]) && Object.is(tag[key], applied.tagState[key])) {
                        if (Object.hasOwn(old, key)) tag[key] = old[key]; else delete tag[key];
                    }
                }
            }
        }
        if (floor.message.is_system === applied.isSystem) {
            if (floor.isSystem === undefined) delete floor.message.is_system;
            else floor.message.is_system = floor.isSystem;
        }
        if (getContext().chat?.[floor.index] === floor.message) {
            const element = document.querySelector(`.mes[mesid="${floor.index}"]`);
            if (element?.getAttribute('is_system') === applied.domVisibility) {
                if (floor.domVisibility === null) element.removeAttribute('is_system');
                else element.setAttribute('is_system', floor.domVisibility);
            }
        }
    }
}

async function mutateFloors(context, scope, floors, change, persist = false) {
    if (persist) await persistItems(scope, floors.map(floor => ({ source: floor.proposed.source,
        revision: floor.proposed.revision, text: floor.text, role: floor.role })), api);
    assertFloorsCurrent(context, scope, floors);
    let saved = false;
    try {
        for (const floor of floors) {
            const message = floor.message;
            message.extra ??= {};
            message.extra.long_memory_bridge ??= { ...floor.proposed };
            change(message, message.extra.long_memory_bridge);
            syncFloorDomVisibility(floor.index, Boolean(message.is_system));
            floor.applied = captureFloors(context, [floor.index])[0];
        }
        await context.saveChat();
        saved = true;
        assertFloorsCurrent(context, scope, floors.map(floor => floor.applied));
    } catch (error) {
        rollbackFloors(floors);
        if (saved) {
            const current = getContext();
            let target;
            try { target = makeMemoryScope(current, settings().worldOverride); } catch {}
            if (current.chat === context.chat && target?.chat === scope.chat && target?.world === scope.world) {
                try { await context.saveChat(); } catch { throw new Error('memory_rollback_save_failed_keep_visible'); }
            }
        }
        throw error;
    }
}

async function offloadOverflowFloors({ keepFloors = settings().maxActiveFloors, reason = '手动收起', skipRefresh = false } = {}) {
    const context = getContext();
    const scope = makeMemoryScope(context, settings().worldOverride);
    const chat = context.chat || [];
    if (!scope || !chat.length) return 0;
    const active = chat.flatMap((message, index) => !message || message.is_system || message.extra?.long_memory_bridge?.pinned ||
        typeof message.mes !== 'string' || !message.mes.trim() ? [] : [index]);
    const keep = Math.max(2, Math.floor(Number(keepFloors) || 12));
    if (active.length <= keep) return 0;
    const floors = captureFloors(context, active.slice(0, active.length - keep));
    await mutateFloors(context, scope, floors, (message, tag) => {
        tag.offloaded = true; tag.offloadedAt = Date.now(); message.is_system = true;
    }, true);
    recordTransition({ type: '收起入库', fromState: 'WINDOW', toState: 'VAULT', source: `floors_${floors[0].index}_${floors.at(-1).index}`,
        floorIndex: floors[0].index, charLen: floors.reduce((sum, floor) => sum + floor.text.length, 0),
        detail: `已确认完整保存并收起 ${floors.length} 层对话 (${reason})` });
    showStatus(`已确认完整保存并收起 ${floors.length} 层对话`, 'ready');
    if (!skipRefresh) await refreshObservabilitySnapshot({ fetchDb: false });
    return floors.length;
}

async function restoreOffloadedFloors({ floorIndex = null } = {}) {
    const context = getContext();
    const scope = makeMemoryScope(context, settings().worldOverride);
    if (!scope) return 0;
    const indices = (context.chat || []).flatMap((message, index) =>
        (floorIndex === null || floorIndex === index) && message?.extra?.long_memory_bridge?.offloaded ? [index] : []);
    if (!indices.length) return 0;
    const floors = captureFloors(context, indices);
    await mutateFloors(context, scope, floors, (message, tag) => { tag.offloaded = false; message.is_system = false; });
    recordTransition({ type: '恢复显示', fromState: 'VAULT', toState: 'WINDOW', source: `restore_${indices[0]}`,
        floorIndex: indices[0], charLen: floors.reduce((sum, floor) => sum + floor.text.length, 0), detail: `已恢复 ${floors.length} 层对话` });
    showStatus(`已恢复 ${floors.length} 层对话`, 'ready');
    await refreshObservabilitySnapshot({ fetchDb: false });
    return floors.length;
}

async function toggleFloorState(floorIndex, targetMode) {
    if (!['pin', 'offload', 'restore'].includes(targetMode)) return;
    const context = getContext();
    const scope = makeMemoryScope(context, settings().worldOverride);
    const message = context.chat?.[floorIndex];
    if (!scope || !message || typeof message.mes !== 'string' || !message.mes.trim()) return;
    const floors = captureFloors(context, [floorIndex]);
    const previous = floors[0].proposed.pinned ? 'PINNED' : message.is_system ? 'VAULT' : 'WINDOW';
    await mutateFloors(context, scope, floors, (msg, tag) => {
        if (targetMode === 'pin') {
            tag.pinned = !tag.pinned;
            if (tag.pinned) { tag.offloaded = false; msg.is_system = false; }
        } else {
            if (targetMode === 'offload') { tag.pinned = false; tag.offloadedAt = Date.now(); }
            tag.offloaded = targetMode === 'offload'; msg.is_system = tag.offloaded;
        }
    }, targetMode === 'offload');
    recordTransition({ type: targetMode === 'offload' ? '收起入库' : targetMode === 'restore' ? '恢复显示' : '更新置顶',
        fromState: previous, toState: message.extra.long_memory_bridge.pinned ? 'PINNED' : message.is_system ? 'VAULT' : 'WINDOW',
        source: message.extra.long_memory_bridge.source, floorIndex, role: message.is_user ? 'user' : 'assistant', charLen: message.mes.length,
        detail: `第 #${floorIndex} 层状态已保存` });
    await refreshObservabilitySnapshot({ fetchDb: false });
}

function archiveTarget() {
    const context = getContext();
    if (context.groupId !== undefined && context.groupId !== null && context.groupId !== '') return null;
    const avatar = context.characters?.[context.characterId]?.avatar;
    const scope = makeMemoryScope(context, settings().worldOverride);
    return typeof avatar === 'string' && scope ? { avatar, world: scope.world } : null;
}

function renderArchiveStatus(status) {
    if (status.phase === 'ready') {
        showArchiveStatus(`旧会话检查完成：导入 ${status.importedFiles} 个，未变化 ${status.skippedFiles} 个，移除 ${status.removedFiles} 个`, 'ready');
    } else if (status.phase === 'error') {
        showArchiveStatus(`旧会话导入有 ${status.failedFiles} 个失败；可点“重新扫描旧聊天”重试`, 'error');
    } else {
        showArchiveStatus(`旧会话导入中：${status.importedFiles + status.skippedFiles}/${status.totalFiles} 个会话`, 'normal');
    }
}

function pollArchive(target, ticket) {
    archiveTimer = setTimeout(async () => {
        if (ticket !== archiveTicket || !settings().enabled || !settings().autoImportHistory) return;
        try {
            const status = await request('/archive/status', target);
            if (ticket !== archiveTicket) return;
            renderArchiveStatus(status);
            if (status.phase === 'queued' || status.phase === 'running') pollArchive(target, ticket);
        } catch {
            if (ticket === archiveTicket) showArchiveStatus('旧会话导入状态暂不可用', 'error');
        }
    }, 5000);
}

function pauseArchiveCurrent() {
    if (archiveCurrentTarget) request('/archive/pause', archiveCurrentTarget).catch(() => undefined);
    archiveCurrentTarget = undefined;
    archiveKey = '';
    archiveTicket++;
    clearTimeout(archiveTimer);
}

function startArchiveForCurrent({ force = false } = {}) {
    const target = archiveTarget();
    if (!settings().enabled || !settings().autoImportHistory || !target) {
        pauseArchiveCurrent();
        return;
    }
    const key = `${target.world}\0${target.avatar}`;
    if (archiveKey === key && !force) return;
    if (archiveCurrentTarget && archiveKey !== key) pauseArchiveCurrent();
    archiveKey = key;
    archiveCurrentTarget = target;
    const ticket = ++archiveTicket;
    clearTimeout(archiveTimer);
    showArchiveStatus('正在检查当前角色卡的旧会话…');
    request('/archive/start', { ...target, force }).then(status => {
        if (ticket !== archiveTicket) return;
        renderArchiveStatus(status);
        if (status.phase === 'queued' || status.phase === 'running') pollArchive(target, ticket);
    }).catch(() => {
        if (ticket === archiveTicket) {
            archiveKey = '';
            showArchiveStatus('旧会话导入暂不可用；可手动重试', 'error');
        }
    });
}

function enqueue(task) {
    pending = pending.catch(() => undefined).then(task).catch(error => {
        showStatus('记忆写入暂不可用；下次生成前会重试', 'error');
        throw error;
    });
    return pending;
}

async function rememberAt(index, type = '') {
    if (!settings().enabled || type === 'first_message') return;
    const context = getContext();
    const scope = makeMemoryScope(context, settings().worldOverride);
    const message = context.chat?.[Number(index)];
    if (!scope || !message || (message.is_system && !message.extra?.long_memory_bridge?.offloaded) ||
        typeof message.mes !== 'string' || !message.mes.trim()) return;
    const floors = captureFloors(context, [Number(index)]);
    floors[0].proposed.revision = nextRevision(floors[0].proposed.revision);
    return enqueue(async () => {
        await mutateFloors(context, scope, floors, (_message, tag) => { tag.revision = floors[0].proposed.revision; }, true);
        recordTransition({ type: '新消息备份', fromState: 'WINDOW', toState: 'VAULT', source: floors[0].proposed.source,
            floorIndex: Number(index), role: floors[0].role, charLen: floors[0].text.length,
            detail: `第 #${index} 层消息已确认完整备份进本地记忆库` });
    });
}

function reconcileCurrent() {
    if (!settings().enabled) return;
    const context = getContext();
    const scope = makeMemoryScope(context, settings().worldOverride);
    if (!scope) return;
    return enqueue(() => syncTagged(scope, context.chat, api));
}

function currentQuery(messages) {
    return (messages || [])
        .filter(item => item && !item.is_system && typeof item.mes === 'string')
        .slice(-3)
        .map(item => item.mes.slice(-700))
        .join('\n')
        .slice(-1600);
}

function collectPinnedItems(messages) {
    return (messages || []).flatMap((msg, idx) => {
        const tag = msg?.extra?.long_memory_bridge;
        if (!tag?.pinned || typeof msg.mes !== 'string' || !msg.mes.trim()) return [];
        return [{
            source: tag.source,
            role: msg.is_user ? 'user' : 'assistant',
            text: msg.mes,
            floorIndex: idx,
        }];
    });
}

globalThis.longMemoryGenerationInterceptor = async function (_chat, contextSize, abort) {
    clearPrompt();
    if (!settings().enabled) return;
    if (bypassOnce) {
        bypassOnce = false;
        showStatus('本次无记忆继续；下次恢复', 'warning');
        return;
    }
    const context = getContext();
    try {
        const scope = makeMemoryScope(context, settings().worldOverride);
        if (!scope) return;
        const isCurrent = () => {
            const current = getContext();
            const target = makeMemoryScope(current, settings().worldOverride);
            return settings().enabled && current.chat === context.chat && target?.world === scope.world && target?.chat === scope.chat;
        };
        await pending.catch(() => undefined);
        if (!isCurrent()) return;

        if (settings().autoOffloadOverflow) {
            await offloadOverflowFloors({
                keepFloors: settings().maxActiveFloors,
                reason: '超出保留楼层数自动收起',
                skipRefresh: true,
            });
        }

        if (!isCurrent()) return;
        await syncTagged(scope, context.chat, api);
        if (!isCurrent()) return;

        const inWindowSources = activeWindowSources(context.chat);
        const query = currentQuery(context.chat);
        observabilityRuntime.lastQuery = query;

        const prevRecalled = new Set(observabilityRuntime.lastRecalledMatches.map(m => m.source));
        const matches = query ? await api.recall(scope, query, inWindowSources) : [];
        if (!isCurrent()) return;
        observabilityRuntime.lastRecalledMatches = matches;

        const currentRecalled = new Set(matches.map(m => m.source));
        for (const oldSource of prevRecalled) {
            if (!currentRecalled.has(oldSource)) {
                recordTransition({
                    type: '用完放回',
                    fromState: 'RECALLED',
                    toState: 'VAULT',
                    source: oldSource,
                    floorIndex: null,
                    role: 'assistant',
                    charLen: 0,
                    detail: `上一轮临时引用的记忆本轮不再需要，已自动放回记忆库`,
                });
            }
        }
        for (const m of matches) {
            const matchDesc = m.match === 'direct' ? '关键词直接匹配' : '顺藤摸瓜关联匹配';
            recordTransition({
                type: '自动找回',
                fromState: 'VAULT',
                toState: 'RECALLED',
                source: m.source,
                floorIndex: null,
                role: m.role,
                charLen: (m.text || '').length,
                detail: `${matchDesc}（匹配度 ${m.score ?? 'N/A'}，命中词：[${(m.matched_terms || []).join('、')}]），本轮已自动带给 AI 参考`,
            });
        }

        const stillCurrent = makeMemoryScope(getContext(), settings().worldOverride);
        if (!stillCurrent || stillCurrent.chat !== scope.chat || stillCurrent.world !== scope.world) {
            clearPrompt();
            return;
        }
        const pinnedItems = collectPinnedItems(context.chat);
        const tokenBudget = Number.isFinite(contextSize) && contextSize > 0
            ? Math.min(2200, Math.floor(contextSize * 0.12)) : 900;
        const knowledge = typeof getKnowledgePrompt === 'function' ? await getKnowledgePrompt(scope, Math.floor(tokenBudget * 0.3), getTokenCountAsync) : '';
        const memory = await fitPrompt(matches, knowledge ? Math.floor(tokenBudget * 0.65) : tokenBudget, getTokenCountAsync, pinnedItems);
        const combined = [memory, knowledge].filter(Boolean).join('\n');
        const prompt = await getTokenCountAsync(combined) <= tokenBudget ? combined : memory;
        if (!isCurrent()) { clearPrompt(); return; }
        setExtensionPrompt(PROMPT_KEY, prompt, extension_prompt_types.IN_PROMPT, 0, false);
        showStatus(`记忆就绪；本轮自动找回 ${matches.length} 条旧记忆，附带 ${pinnedItems.length} 条重点置顶`, 'ready');
        updatePillBadge();
    } catch (error) {
        clearPrompt();
        console.warn('[LongMemory] Memory bridge timed out or unavailable, proceeding without memory:', error);
        showStatus('长期记忆超时或暂不可用，已跳过记忆继续生成', 'warning');
    }
};

// =========================================================================
// 零卡顿事件驱动画布渲染引擎 (0% 闲置开销 + 离屏背景缓存 + 整洁网格排布)
// =========================================================================
const SUBSPACE_REGIONS = {
    WINDOW: {
        title: '💬 当前聊天 (正在发送)',
        subtitle: '留在当前窗口里、每轮直接发给 AI 的对话',
        color: '#38bdf8',
        bg: 'rgba(56, 189, 248, 0.07)',
        rx: 0.255,
        ry: 0.265,
    },
    VAULT: {
        title: '📦 放进记忆库 (已收起)',
        subtitle: '不占当前字数 · 原文完整保存在本地库里',
        color: '#818cf8',
        bg: 'rgba(129, 140, 248, 0.07)',
        rx: 0.745,
        ry: 0.265,
    },
    RECALLED: {
        title: '🎯 本轮自动找回 (已引用)',
        subtitle: '跟当前聊的内容相关、这一轮自动调出来的旧记忆',
        color: '#10b981',
        bg: 'rgba(16, 185, 129, 0.08)',
        rx: 0.745,
        ry: 0.745,
    },
    PINNED: {
        title: '📌 重点置顶 (常驻不收起)',
        subtitle: '打上重点标记、清理空间时永远不会被自动收起',
        color: '#f59e0b',
        bg: 'rgba(245, 158, 11, 0.08)',
        rx: 0.255,
        ry: 0.745,
    },
};

function memoryNodeKey(chat, source) {
    return JSON.stringify([chat || '', source]);
}

function buildPartitionModel() {
    const context = getContext();
    const chat = context.chat || [];
    const currentChatHash = observabilityRuntime.dbSnapshot?.nodes?.find(node => node.is_current_chat)?.chat;
    const recalledMap = new Map(observabilityRuntime.lastRecalledMatches.map(m => [memoryNodeKey(m.chat, m.source), m]));
    const nodes = [];
    const seenSources = new Set();

    // 1. 当前聊天楼层 (内存直接秒读，0 I/O)
    for (let i = 0; i < chat.length; i++) {
        const msg = chat[i];
        if (!msg || typeof msg.mes !== 'string' || !msg.mes.trim()) continue;
        if (msg.is_system && !msg.extra?.long_memory_bridge?.offloaded) continue;
        const tag = ensureMessageTag(msg);
        const source = tag?.source || `floor_${i}`;
        seenSources.add(memoryNodeKey(currentChatHash, source));
        const recallHit = recalledMap.get(memoryNodeKey(currentChatHash, source));

        let subspace = 'WINDOW';
        if (tag?.pinned) {
            subspace = 'PINNED';
        } else if (recallHit) {
            subspace = 'RECALLED';
        } else if (msg.is_system || tag?.offloaded) {
            subspace = 'VAULT';
        }

        nodes.push({
            key: `floor:${i}`,
            label: `#${i}`,
            source,
            itemChat: currentChatHash,
            floorIndex: i,
            isCurrentChat: true,
            role: msg.is_user ? 'user' : 'assistant',
            subspace,
            charLen: msg.mes.length,
            body: msg.mes,
            preview: msg.mes.slice(0, 120),
            revision: tag?.revision || 1,
            matchInfo: recallHit || null,
            topTerms: recallHit?.matched_terms || [],
        });
    }

    // 2. 补充本轮召回但不在当前聊天里的旧档记忆
    let archiveIdx = 1;
    for (const m of observabilityRuntime.lastRecalledMatches) {
        if (seenSources.has(memoryNodeKey(m.chat, m.source))) continue;
        seenSources.add(memoryNodeKey(m.chat, m.source));
        nodes.push({
            key: `db:${memoryNodeKey(m.chat, m.source)}`,
            label: `旧${archiveIdx++}`,
            source: m.source,
            itemChat: m.chat,
            floorIndex: null,
            isCurrentChat: false,
            role: m.role,
            subspace: 'RECALLED',
            charLen: m.full_length || (m.text || '').length,
            body: null,
            preview: (m.text || '').slice(0, 120),
            revision: m.revision || 1,
            matchInfo: m,
            topTerms: m.matched_terms || [],
        });
    }

    // 3. 补充轻量级数据库快照里的代表节点（不传大正文，毫秒级）
    const snapNodes = observabilityRuntime.dbSnapshot?.nodes || [];
    for (const dbNode of snapNodes) {
        if (seenSources.has(memoryNodeKey(dbNode.chat, dbNode.source))) continue;
        seenSources.add(memoryNodeKey(dbNode.chat, dbNode.source));
        nodes.push({
            key: `db:${memoryNodeKey(dbNode.chat, dbNode.source)}`,
            label: `旧${archiveIdx++}`,
            source: dbNode.source,
            itemChat: dbNode.chat,
            floorIndex: null,
            isCurrentChat: Boolean(dbNode.is_current_chat),
            role: dbNode.role,
            subspace: 'VAULT',
            charLen: dbNode.char_len || 0,
            body: null, // 点击时再按需秒查全文
            preview: dbNode.preview || '',
            revision: dbNode.revision || 1,
            matchInfo: null,
            topTerms: [],
        });
    }

    return nodes;
}

function layoutStateSpaceNodes() {
    const allNodes = buildPartitionModel();
    const groups = { WINDOW: [], VAULT: [], RECALLED: [], PINNED: [] };
    for (const node of allNodes) {
        (groups[node.subspace] || groups.VAULT).push(node);
    }

    const MAX_PER_BOX = 24; // 6列 x 4行整洁网格，杜绝重叠与卡顿
    const COLS = 6;
    const ROWS = 4;
    const rendered = [];

    for (const [subspace, list] of Object.entries(groups)) {
        const reg = SUBSPACE_REGIONS[subspace];
        // 对于当前聊天，优先展示最近的 24 层
        const visibleList = subspace === 'WINDOW' ? list.slice(-MAX_PER_BOX) : list.slice(0, MAX_PER_BOX);
        observabilityRuntime.overflowCounts[subspace] = Math.max(0, list.length - visibleList.length);

        // 安全内边距区域（严格避开顶部标题栏 46px 与底部边框）
        const startX = reg.rx - 0.175;
        const spanX = 0.35;
        const startY = reg.ry - 0.085;
        const spanY = 0.24;

        visibleList.forEach((node, idx) => {
            const col = idx % COLS;
            const row = Math.floor(idx / COLS);
            node.nx = startX + (col / (COLS - 1)) * spanX;
            node.ny = startY + (row / Math.max(1, ROWS - 1)) * spanY;
            node.radius = 7.5;
            rendered.push(node);
        });
    }

    observabilityRuntime.renderedNodes = rendered;
    if (!observabilityRuntime.selectedNodeKey && rendered.length > 0) {
        observabilityRuntime.selectedNodeKey = rendered[0].key;
    }
}

async function refreshObservabilitySnapshot({ fetchDb = true } = {}) {
    const context = getContext();
    const scope = makeMemoryScope(context, settings().worldOverride);
    if (fetchDb && scope) {
        try {
            observabilityRuntime.dbSnapshot = await api.inspect(scope, 36);
        } catch {
            // Keep existing snapshot
        }
    }
    layoutStateSpaceNodes();
    updateTelemetryCounters();
    renderRawInspector();
    updatePillBadge();
    requestRender();
}

function spawnTransitionParticle(fromState, toState, type) {
    const a = SUBSPACE_REGIONS[fromState] || SUBSPACE_REGIONS.WINDOW;
    const b = SUBSPACE_REGIONS[toState] || SUBSPACE_REGIONS.VAULT;
    if (!a || !b || observabilityRuntime.particles.length >= 6) return;
    observabilityRuntime.particles.push({
        ax: a.rx,
        ay: a.ry,
        bx: b.rx,
        by: b.ry,
        t: 0,
        color: b.color,
        label: type,
    });
    requestRender();
}

function renderOffscreenBackground(W, H) {
    const offscreen = document.createElement('canvas');
    offscreen.width = W;
    offscreen.height = H;
    const ctx = offscreen.getContext('2d');

    ctx.strokeStyle = 'rgba(148, 163, 184, 0.05)';
    ctx.lineWidth = 1;
    for (let x = 0; x < W; x += 40) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    for (let y = 0; y < H; y += 40) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }

    const boxW = W * 0.45;
    const boxH = H * 0.43;
    for (const reg of Object.values(SUBSPACE_REGIONS)) {
        const cx = reg.rx * W;
        const cy = reg.ry * H;
        const x0 = cx - boxW / 2;
        const y0 = cy - boxH / 2;

        ctx.fillStyle = reg.bg;
        ctx.strokeStyle = reg.color + '55';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.roundRect(x0, y0, boxW, boxH, 12);
        ctx.fill();
        ctx.stroke();

        // 标题区与底部分隔细线，防止圆点与文字重叠
        ctx.strokeStyle = reg.color + '22';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x0 + 10, y0 + 44);
        ctx.lineTo(x0 + boxW - 10, y0 + 44);
        ctx.stroke();

        ctx.fillStyle = reg.color;
        ctx.font = 'bold 12.5px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        ctx.fillText(reg.title, x0 + 12, y0 + 20);
        ctx.fillStyle = 'rgba(148, 163, 184, 0.82)';
        ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        ctx.fillText(reg.subtitle, x0 + 12, y0 + 36);
    }

    const channels = [
        { a: 'WINDOW', b: 'VAULT', label: '收起入库 →', dy: -8, color: '#818cf8' },
        { a: 'VAULT', b: 'WINDOW', label: '← 恢复显示', dy: 10, color: '#38bdf8' },
        { a: 'VAULT', b: 'RECALLED', label: '↓ 自动找回', dx: 8, color: '#10b981' },
        { a: 'WINDOW', b: 'PINNED', label: '↓ 设为置顶', dx: -8, color: '#f59e0b' },
    ];
    for (const ch of channels) {
        const ra = SUBSPACE_REGIONS[ch.a];
        const rb = SUBSPACE_REGIONS[ch.b];
        const x1 = ra.rx * W + (ch.dx || 0);
        const y1 = ra.ry * H + (ch.dy || 0);
        const x2 = rb.rx * W + (ch.dx || 0);
        const y2 = rb.ry * H + (ch.dy || 0);

        ctx.strokeStyle = ch.color + '38';
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = ch.color;
        ctx.font = '10.5px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(ch.label, (x1 + x2) / 2, (y1 + y2) / 2 - 3);
    }

    observabilityRuntime.bgCanvas = offscreen;
    observabilityRuntime.bgWidth = W;
    observabilityRuntime.bgHeight = H;
}

function drawStateSpaceCanvas() {
    observabilityRuntime.rafId = null;
    const modal = document.getElementById('lm_observability_modal');
    if (!modal || !modal.classList.contains('lm-open')) return;

    const canvas = document.getElementById('lm_state_space_canvas');
    if (!canvas) return;
    const W = canvas.width;
    const H = canvas.height;
    if (W <= 0 || H <= 0) return;

    if (!observabilityRuntime.bgCanvas || observabilityRuntime.bgWidth !== W || observabilityRuntime.bgHeight !== H) {
        renderOffscreenBackground(W, H);
    }

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(observabilityRuntime.bgCanvas, 0, 0);

    // 绘制超出 24 个时的汇总角标
    const boxW = W * 0.45;
    const boxH = H * 0.43;
    const totalVault = Math.max(
        observabilityRuntime.renderedNodes.filter(n => n.subspace === 'VAULT').length,
        observabilityRuntime.dbSnapshot?.world_total_nodes || 0
    );
    for (const [subspace, reg] of Object.entries(SUBSPACE_REGIONS)) {
        const extra = subspace === 'VAULT'
            ? Math.max(0, totalVault - observabilityRuntime.renderedNodes.filter(n => n.subspace === 'VAULT').length)
            : (observabilityRuntime.overflowCounts[subspace] || 0);
        if (extra > 0) {
            const xRight = reg.rx * W + boxW / 2 - 12;
            const yTop = reg.ry * H - boxH / 2 + 20;
            ctx.fillStyle = '#cbd5e1';
            ctx.font = '11px monospace';
            ctx.textAlign = 'right';
            ctx.fillText(`+${extra} 条在库中`, xRight, yTop);
        }
    }

    // 绘制顺藤摸瓜关联线
    const nodesBySource = new Map(observabilityRuntime.renderedNodes.map(n => [n.source, n]));
    for (const node of observabilityRuntime.renderedNodes) {
        if (node.matchInfo?.via_source) {
            const seed = nodesBySource.get(node.matchInfo.via_source);
            if (seed) {
                ctx.strokeStyle = '#10b981';
                ctx.lineWidth = 1.8;
                ctx.beginPath();
                ctx.moveTo(seed.nx * W, seed.ny * H);
                ctx.lineTo(node.nx * W, node.ny * H);
                ctx.stroke();
            }
        }
    }

    // 绘制动画粒子（无 shadowBlur 卡顿）
    for (let i = observabilityRuntime.particles.length - 1; i >= 0; i--) {
        const p = observabilityRuntime.particles[i];
        p.t += 0.05;
        if (p.t >= 1) {
            observabilityRuntime.particles.splice(i, 1);
            continue;
        }
        const px = (p.ax + (p.bx - p.ax) * p.t) * W;
        const py = (p.ay + (p.by - p.ay) * p.t) * H;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(px, py, 5.5, 0, Math.PI * 2);
        ctx.fill();
    }

    // 绘制节点（纯矢量双环高亮，不用昂贵的 shadowBlur）
    ctx.textAlign = 'center';
    ctx.font = '10px monospace';
    for (const node of observabilityRuntime.renderedNodes) {
        const reg = SUBSPACE_REGIONS[node.subspace] || SUBSPACE_REGIONS.VAULT;
        const x = node.nx * W;
        const y = node.ny * H;
        const isSelected = node.key === observabilityRuntime.selectedNodeKey;

        if (isSelected) {
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 2.5;
            ctx.beginPath();
            ctx.arc(x, y, node.radius + 3.5, 0, Math.PI * 2);
            ctx.stroke();
        }

        ctx.fillStyle = reg.color;
        ctx.strokeStyle = '#0f172a';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x, y, node.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = isSelected ? '#ffffff' : '#cbd5e1';
        ctx.fillText(node.label, x, y - node.radius - 4);
    }

    // 只有存在运动粒子时才请求下一帧，静止时 0% CPU 占用
    if (observabilityRuntime.particles.length > 0) {
        observabilityRuntime.rafId = requestAnimationFrame(drawStateSpaceCanvas);
    }
}

function requestRender() {
    if (observabilityRuntime.rafId !== null) return;
    observabilityRuntime.rafId = requestAnimationFrame(drawStateSpaceCanvas);
}

function updateTelemetryCounters() {
    const context = getContext();
    const chat = context.chat || [];
    let wCount = 0, wChars = 0;
    let pCount = 0, pChars = 0;
    let offCount = 0, offChars = 0;

    for (const m of chat) {
        if (!m || typeof m.mes !== 'string' || !m.mes.trim()) continue;
        const tag = m.extra?.long_memory_bridge;
        const len = m.mes.length;
        if (tag?.pinned) {
            pCount++; pChars += len;
        } else if (m.is_system && tag?.offloaded) {
            offCount++; offChars += len;
        } else if (!m.is_system) {
            wCount++; wChars += len;
        }
    }

    const rList = observabilityRuntime.lastRecalledMatches;
    const rChars = rList.reduce((acc, m) => acc + (m.text || '').length, 0);

    const totalVaultNodes = Math.max(offCount, observabilityRuntime.dbSnapshot?.world_total_nodes || offCount);
    const totalVaultChars = Math.max(offChars, observabilityRuntime.dbSnapshot?.world_total_chars || offChars);

    const setEl = (id, text) => {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    };
    setEl('lm_stat_omega1', `${wCount} 层 (${(wChars / 1000).toFixed(1)}k 字)`);
    setEl('lm_stat_omega2', `${totalVaultNodes} 条 (${(totalVaultChars / 1000).toFixed(1)}k 字)`);
    setEl('lm_stat_omega3', `${rList.length} 条 (${(rChars / 1000).toFixed(1)}k 字)`);
    setEl('lm_stat_omega4', `${pCount} 条 (${(pChars / 1000).toFixed(1)}k 字)`);
}

function updatePillBadge() {
    const pillText = document.getElementById('lm_pill_text');
    if (!pillText) return;
    const context = getContext();
    const chat = context.chat || [];
    let inWindow = 0;
    let offloaded = 0;
    for (const m of chat) {
        if (!m || typeof m.mes !== 'string' || !m.mes.trim()) continue;
        if (m.extra?.long_memory_bridge?.offloaded) offloaded++;
        else if (!m.is_system) inWindow++;
    }
    const recalled = observabilityRuntime.lastRecalledMatches.length;
    pillText.textContent = `当前:${inWindow} | 记忆库:${offloaded}+旧档 | 引用:${recalled}`;
}

function renderTransitionLedger() {
    const container = document.getElementById('lm_tab_transitions');
    if (!container) return;
    if (!observabilityRuntime.transitions.length) {
        container.innerHTML = `<div style="color:#94a3b8;font-size:12px;padding:12px;">还没有产生记忆流转记录。点上方「📥 收起旧对话到记忆库」或「🔍 试试自动找回旧记忆」就能看到变化过程。</div>`;
        return;
    }
    container.innerHTML = observabilityRuntime.transitions.slice(0, 30).map(item => {
        const badgeColor = item.type === '收起入库' ? '#818cf8'
            : item.type === '自动找回' ? '#10b981'
            : item.type === '恢复显示' ? '#38bdf8'
            : item.type === '设为置顶' ? '#f59e0b' : '#94a3b8';
        const floorLabel = item.floorIndex !== null && item.floorIndex !== undefined ? `第 #${item.floorIndex} 层` : `旧会话记忆`;
        const fromName = STATE_NAMES[item.fromState] || item.fromState;
        const toName = STATE_NAMES[item.toState] || item.toState;
        return `
            <div class="lm-transition-item" style="border-left-color:${badgeColor}">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <strong style="color:${badgeColor};">[${item.type}] ${fromName} → ${toName}</strong>
                    <span style="color:#64748b;font-family:monospace;font-size:11px;">${item.timestamp}</span>
                </div>
                <div style="color:#cbd5e1;">
                    <span class="lm-node-pill">${floorLabel}</span>
                    <span class="lm-node-pill">${item.role === 'user' ? '你' : '角色'} · ${item.charLen} 字</span>
                    ${item.detail}
                </div>
            </div>
        `;
    }).join('');
}

async function renderRawInspector() {
    const container = document.getElementById('lm_tab_inspector');
    if (!container) return;
    const node = observabilityRuntime.renderedNodes.find(n => n.key === observabilityRuntime.selectedNodeKey)
        || observabilityRuntime.renderedNodes[0];
    if (!node) {
        container.innerHTML = `<div style="color:#94a3b8;font-size:12px;padding:12px;">当前聊天或记忆库里还没有内容。</div>`;
        return;
    }
    const reg = SUBSPACE_REGIONS[node.subspace] || SUBSPACE_REGIONS.VAULT;
    const matchHtml = node.matchInfo
        ? `<div style="padding:6px 10px;background:rgba(16,185,129,0.12);border:1px solid rgba(16,185,129,0.35);border-radius:6px;font-size:12px;color:#6ee7b7;">
             🎯 <strong>这一轮被自动找回</strong>：${node.matchInfo.match === 'direct' ? '关键词直接命中' : '顺藤摸瓜关联命中'} · 匹配度 <code>${node.matchInfo.score ?? 'N/A'}</code>
           </div>`
        : '';

    const controlsHtml = node.floorIndex !== null
        ? `<div class="lm-btn-row">
             <button class="lm-btn" data-lm-action="offload" data-floor="${node.floorIndex}">📥 收进记忆库 (省字数)</button>
             <button class="lm-btn" data-lm-action="restore" data-floor="${node.floorIndex}">📤 放回当前聊天</button>
             <button class="lm-btn" data-lm-action="pin" data-floor="${node.floorIndex}">📌 设为重点置顶 (不收起)</button>
           </div>`
        : `<div style="font-size:11px;color:#94a3b8;">📦 这条内容来自以前的旧聊天存档，原文完整保存在本地记忆库中。</div>`;

    container.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:8px;">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
                <span style="font-weight:700;color:${reg.color};font-size:13px;">${reg.title}</span>
                <span class="lm-node-pill">${node.floorIndex !== null ? `第 #${node.floorIndex} 层` : `旧存档 (${node.label})`}</span>
            </div>
            <div style="font-size:12px;color:#94a3b8;">
                发言人：${node.role === 'user' ? '你' : '角色'} &nbsp;|&nbsp; 原文长度：<strong>${node.charLen} 字（完整无删减）</strong>
            </div>
            ${matchHtml}
            <div id="lm_inspector_terms" style="font-size:12px;color:#cbd5e1;"></div>
            ${controlsHtml}
            <div style="font-size:12px;font-weight:600;color:#e2e8f0;margin-top:4px;">📄 完整原始内容：</div>
            <div class="lm-raw-box" id="lm_raw_body_box"></div>
        </div>
    `;

    const rawBox = container.querySelector('#lm_raw_body_box');
    const termsBox = container.querySelector('#lm_inspector_terms');

    container.querySelectorAll('[data-lm-action]').forEach(btn => {
        btn.addEventListener('click', manualAction(async () => {
            const action = btn.getAttribute('data-lm-action');
            const floor = Number(btn.getAttribute('data-floor'));
            await toggleFloorState(floor, action);
        }));
    });

    // 若是当前楼层，直接秒显内存原文；若是旧存档且尚未拉取全文，先显预览再按需秒拉全文
    if (node.body !== null && node.body !== undefined) {
        if (rawBox) rawBox.textContent = node.body || '（空）';
        if (termsBox) {
            const termsHtml = (node.topTerms || []).map(t => `<span class="lm-node-pill">${t}</span>`).join('');
            termsBox.innerHTML = termsHtml ? `包含的关键词：${termsHtml}` : '';
        }
        return;
    }

    const scope = makeMemoryScope(getContext(), settings().worldOverride);
    const cacheKey = JSON.stringify([scope?.world, node.itemChat || scope?.chat, node.source]);
    const cached = observabilityRuntime.itemCache.get(cacheKey);
    if (cached) {
        if (rawBox) rawBox.textContent = cached.body;
        if (termsBox && cached.top_terms?.length) {
            termsBox.innerHTML = `包含的关键词：` + cached.top_terms.map(t => `<span class="lm-node-pill">${t}</span>`).join('');
        }
        return;
    }

    if (rawBox) rawBox.textContent = (node.preview || '') + '\n\n（正在从本地库读取完整原文…）';
    if (scope) {
        try {
            const fullItem = await api.getItem(scope, node.source, node.itemChat);
            if (fullItem) {
                observabilityRuntime.itemCache.set(cacheKey, fullItem);
                const currentScope = makeMemoryScope(getContext(), settings().worldOverride);
                if (currentScope?.world === scope.world && currentScope?.chat === scope.chat && observabilityRuntime.selectedNodeKey === node.key) {
                    if (rawBox) rawBox.textContent = fullItem.body || '';
                    if (termsBox && fullItem.top_terms?.length) {
                        termsBox.innerHTML = `包含的关键词：` + fullItem.top_terms.map(t => `<span class="lm-node-pill">${t}</span>`).join('');
                    }
                }
            }
        } catch {
            if (rawBox) rawBox.textContent = node.preview || '';
        }
    }
}

function syncCanvasDimensions() {
    const canvas = document.getElementById('lm_state_space_canvas');
    if (!canvas) return false;
    const rect = canvas.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
        const w = Math.floor(rect.width);
        const h = Math.floor(rect.height);
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
            return true;
        }
    }
    return false;
}

function mountObservabilityModal() {
    if (document.getElementById('lm_observability_modal')) return;

    const pill = document.createElement('div');
    pill.id = 'lm_observability_pill';
    pill.title = '打开记忆库与对话管理面板';
    pill.innerHTML = `
        <span class="lm-pill-dot"></span>
        <span id="lm_pill_text">当前:0 | 记忆库:0 | 引用:0</span>
    `;
    document.body.appendChild(pill);

    const modal = document.createElement('div');
    modal.id = 'lm_observability_modal';
    modal.innerHTML = `
        <div class="lm-modal-shell">
            <div class="lm-modal-header">
                <div class="lm-modal-title">
                    <span>🧠 本地记忆库与对话管理面板</span>
                    <span class="lm-modal-tag">清理爆满空间 · 原文一字不丢</span>
                </div>
                <div class="lm-btn-row" style="margin:0;">
                    <button id="lm_btn_offload_now" class="lm-btn lm-btn-primary" type="button">📥 收起旧对话到记忆库</button>
                    <button id="lm_btn_sim_recall" class="lm-btn" type="button">🔍 试试自动找回旧记忆</button>
                    <button id="lm_btn_restore_all" class="lm-btn" type="button">📤 恢复全部收起的对话</button>
                    <button id="lm_btn_refresh_snap" class="lm-btn" type="button">🔄 刷新记忆库</button>
                    <button id="lm_btn_close_modal" class="lm-btn" type="button">✕ 关闭</button>
                </div>
            </div>
            <div class="lm-telemetry-bar">
                <div class="lm-stat-card" style="border-color:rgba(56,189,248,0.35);">
                    <div class="lm-stat-label"><span>💬 当前聊天 (正在发送)</span><span style="color:#38bdf8;">● 占字数</span></div>
                    <div class="lm-stat-val" id="lm_stat_omega1" style="color:#38bdf8;">0 层</div>
                </div>
                <div class="lm-stat-card" style="border-color:rgba(129,140,248,0.35);">
                    <div class="lm-stat-label"><span>📦 放进记忆库 (已收起)</span><span style="color:#818cf8;">● 不占字数</span></div>
                    <div class="lm-stat-val" id="lm_stat_omega2" style="color:#818cf8;">0 条</div>
                </div>
                <div class="lm-stat-card" style="border-color:rgba(16,185,129,0.35);">
                    <div class="lm-stat-label"><span>🎯 本轮自动找回 (已引用)</span><span style="color:#10b981;">● 按需调出</span></div>
                    <div class="lm-stat-val" id="lm_stat_omega3" style="color:#10b981;">0 条</div>
                </div>
                <div class="lm-stat-card" style="border-color:rgba(245,158,11,0.35);">
                    <div class="lm-stat-label"><span>📌 重点置顶 (常驻不收起)</span><span style="color:#f59e0b;">● 始终保留</span></div>
                    <div class="lm-stat-val" id="lm_stat_omega4" style="color:#f59e0b;">0 条</div>
                </div>
                <div style="display:flex;flex-direction:column;gap:4px;font-size:12px;">
                    <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
                        <input id="lm_modal_auto_offload" type="checkbox" /> 聊多时自动收起早期对话
                    </label>
                    <div style="display:flex;align-items:center;gap:6px;">
                        <span>窗口里最多留几层:</span>
                        <input id="lm_modal_keep_floors" type="number" min="4" max="200" style="width:58px;background:#0f172a;color:#f8fafc;border:1px solid #334155;border-radius:4px;padding:2px 6px;" />
                    </div>
                </div>
            </div>
            <div class="lm-modal-body">
                <div class="lm-diagram-pane">
                    <canvas id="lm_state_space_canvas"></canvas>
                    <div class="lm-diagram-footer">
                        <span>💡 点图里的任意小圆点，就能在右边看它的<strong>完整原文</strong>，或者手动把它收进记忆库 / 放回聊天</span>
                        <span>按需渲染 · 静止时 0% 性能占用</span>
                    </div>
                </div>
                <div class="lm-inspector-pane">
                    <div class="lm-tabs">
                        <div class="lm-tab lm-active" data-lm-tab="inspector">📄 查看完整原文</div>
                        <div class="lm-tab" data-lm-tab="transitions">🔄 记忆流转记录</div>
                    </div>
                    <div class="lm-tab-content lm-active" id="lm_tab_inspector"></div>
                    <div class="lm-tab-content" id="lm_tab_transitions"></div>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    const openModal = async () => {
        modal.classList.add('lm-open');
        const autoChk = document.getElementById('lm_modal_auto_offload');
        const keepInput = document.getElementById('lm_modal_keep_floors');
        if (autoChk) autoChk.checked = settings().autoOffloadOverflow;
        if (keepInput) keepInput.value = settings().maxActiveFloors;
        syncCanvasDimensions();
        await refreshObservabilitySnapshot({ fetchDb: true });
        renderTransitionLedger();
    };

    pill.addEventListener('click', openModal);
    document.getElementById('lm_btn_close_modal').addEventListener('click', () => {
        modal.classList.remove('lm-open');
        if (observabilityRuntime.rafId !== null) {
            cancelAnimationFrame(observabilityRuntime.rafId);
            observabilityRuntime.rafId = null;
        }
    });
    modal.addEventListener('click', e => {
        if (e.target === modal) modal.classList.remove('lm-open');
    });

    window.addEventListener('resize', () => {
        if (modal.classList.contains('lm-open') && syncCanvasDimensions()) {
            requestRender();
        }
    });

    modal.querySelectorAll('.lm-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            modal.querySelectorAll('.lm-tab').forEach(t => t.classList.remove('lm-active'));
            modal.querySelectorAll('.lm-tab-content').forEach(c => c.classList.remove('lm-active'));
            tab.classList.add('lm-active');
            const target = tab.getAttribute('data-lm-tab');
            document.getElementById(`lm_tab_${target}`)?.classList.add('lm-active');
        });
    });

    document.getElementById('lm_btn_offload_now').addEventListener('click', manualAction(async () => {
        const keepInput = document.getElementById('lm_modal_keep_floors');
        const keep = keepInput ? Number(keepInput.value) : settings().maxActiveFloors;
        await offloadOverflowFloors({ keepFloors: keep, reason: '手动点按钮收起' });
    }));
    document.getElementById('lm_btn_restore_all').addEventListener('click', manualAction(async () => {
        await restoreOffloadedFloors();
    }));
    document.getElementById('lm_btn_refresh_snap').addEventListener('click', async () => {
        await refreshObservabilitySnapshot({ fetchDb: true });
    });
    document.getElementById('lm_btn_sim_recall').addEventListener('click', async () => {
        await globalThis.longMemoryGenerationInterceptor(getContext().chat, 8192, () => {});
        await refreshObservabilitySnapshot({ fetchDb: false });
    });

    document.getElementById('lm_modal_auto_offload').addEventListener('change', e => {
        settings().autoOffloadOverflow = e.target.checked;
        saveSettingsDebounced();
    });
    document.getElementById('lm_modal_keep_floors').addEventListener('change', e => {
        settings().maxActiveFloors = Math.max(4, Math.min(200, Number(e.target.value) || 24));
        e.target.value = settings().maxActiveFloors;
        saveSettingsDebounced();
    });

    const canvas = document.getElementById('lm_state_space_canvas');
    canvas.addEventListener('pointerdown', e => {
        const rect = canvas.getBoundingClientRect();
        const x = (e.clientX - rect.left) * (canvas.width / rect.width);
        const y = (e.clientY - rect.top) * (canvas.height / rect.height);
        let closest = null;
        let minDist = 20;
        for (const node of observabilityRuntime.renderedNodes) {
            const dx = node.nx * canvas.width - x;
            const dy = node.ny * canvas.height - y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < minDist) {
                minDist = dist;
                closest = node;
            }
        }
        if (closest) {
            observabilityRuntime.selectedNodeKey = closest.key;
            requestRender();
            renderRawInspector();
        }
    });

    globalThis.openLongMemoryObservabilityConsole = openModal;
}

function initialize() {
    mountObservabilityModal();

    const container = document.getElementById('extensions_settings2');
    if (container && !document.getElementById('long_memory_library')) libraryUI = mountLibrary({container,request,getScope:()=>makeMemoryScope(getContext(),settings().worldOverride),getChat:()=>getContext().chat});
    if (container && !document.getElementById('long_memory_settings')) {
        const panel = document.createElement('section');
        panel.id = 'long_memory_settings';
        panel.innerHTML = `
            <h4><span>本地记忆库管理</span><span style="font-size:11px;color:#38bdf8;">清理爆满 · 不丢原文</span></h4>
            <label><input id="long_memory_enabled" type="checkbox"> 启用记忆库与聊前自动找回旧记忆</label>
            <label><input id="long_memory_auto_import" type="checkbox"> 自动把当前角色卡以前的旧聊天也存进记忆库</label>
            <label><input id="long_memory_auto_offload" type="checkbox"> 对话太多时，自动把前面的旧楼层收进记忆库（省下字数）</label>
            <label for="long_memory_keep_floors">当前聊天窗口里最多留几层（超出的早期楼层自动收进记忆库）</label>
            <input id="long_memory_keep_floors" type="number" min="4" max="200" value="24">
            <label for="long_memory_world">共享记忆分组名（留空则同一个角色卡共用一个记忆库）</label>
            <input id="long_memory_world" type="text" maxlength="4089" placeholder="可选：分组名称">
            <div id="long_memory_status" role="status">正在连接本机记忆库…</div>
            <div id="long_memory_archive_status" role="status">等待检查旧聊天记录…</div>
            <div class="lm-btn-row">
                <button id="long_memory_open_console" class="lm-btn lm-btn-primary" type="button">🧠 打开记忆库可视化面板</button>
                <button id="long_memory_offload_btn" class="lm-btn" type="button">📥 立即收起旧对话到记忆库</button>
                <button id="long_memory_restore_btn" class="lm-btn" type="button">📤 恢复全部收起的对话</button>
                <button id="long_memory_rescan" class="lm-btn" type="button">🔄 重新扫描旧聊天</button>
                <button id="long_memory_bypass" class="lm-btn" type="button">仅下一句不带记忆</button>
            </div>
            <small>记忆原文保存在本机；启用召回后，相关原文会随提示词发送给当前选择的模型及其服务商。只有确认完整保存后才会收起对话，保存失败时原文保持可见。</small>`;
        container.append(panel);
        const enabled = panel.querySelector('#long_memory_enabled');
        const autoImport = panel.querySelector('#long_memory_auto_import');
        const autoOffload = panel.querySelector('#long_memory_auto_offload');
        const keepFloors = panel.querySelector('#long_memory_keep_floors');
        const world = panel.querySelector('#long_memory_world');
        enabled.checked = settings().enabled;
        autoImport.checked = settings().autoImportHistory;
        autoOffload.checked = settings().autoOffloadOverflow;
        keepFloors.value = settings().maxActiveFloors;
        world.value = settings().worldOverride || '';
        enabled.addEventListener('change', () => {
            settings().enabled = enabled.checked;
            saveSettingsDebounced();
            clearPrompt();
            showStatus(enabled.checked ? '已启用；下一轮将检查记忆' : '已停用', enabled.checked ? 'normal' : 'warning');
            if (enabled.checked) startArchiveForCurrent();
            else pauseArchiveCurrent();
        });
        autoImport.addEventListener('change', () => {
            settings().autoImportHistory = autoImport.checked;
            saveSettingsDebounced();
            if (autoImport.checked) startArchiveForCurrent();
            else {
                pauseArchiveCurrent();
                showArchiveStatus('旧会话自动导入已停用', 'warning');
            }
        });
        autoOffload.addEventListener('change', () => {
            settings().autoOffloadOverflow = autoOffload.checked;
            saveSettingsDebounced();
        });
        keepFloors.addEventListener('change', () => {
            settings().maxActiveFloors = Math.max(4, Math.min(200, Number(keepFloors.value) || 24));
            keepFloors.value = settings().maxActiveFloors;
            saveSettingsDebounced();
        });
        world.addEventListener('change', () => {
            settings().worldOverride = world.value.trim();
            saveSettingsDebounced();
            clearPrompt();
            showStatus('记忆分组已更新；下一轮将重新检索');
            startArchiveForCurrent();
        });
        panel.querySelector('#long_memory_open_console').addEventListener('click', () => {
            globalThis.openLongMemoryObservabilityConsole?.();
        });
        panel.querySelector('#long_memory_offload_btn').addEventListener('click', manualAction(() =>
            offloadOverflowFloors({ keepFloors: settings().maxActiveFloors, reason: '设置面板按钮' })));
        panel.querySelector('#long_memory_restore_btn').addEventListener('click', manualAction(() => restoreOffloadedFloors()));
        panel.querySelector('#long_memory_rescan').addEventListener('click', () => startArchiveForCurrent({ force: true }));
        panel.querySelector('#long_memory_bypass').addEventListener('click', () => {
            bypassOnce = true;
            showStatus('已允许下一轮不带记忆继续', 'warning');
        });
    }

    eventSource.on(event_types.MESSAGE_SENT, index => rememberAt(index));
    eventSource.on(event_types.MESSAGE_RECEIVED, (index, type) => rememberAt(index, type));
    eventSource.on(event_types.MESSAGE_EDITED, index => rememberAt(index));
    eventSource.on(event_types.MESSAGE_SWIPED, index => rememberAt(index));
    eventSource.on(event_types.MESSAGE_DELETED, () => reconcileCurrent());
    eventSource.on(event_types.CHAT_CHANGED, () => {
        libraryUI?.resetScope();
        clearPrompt();
        observabilityRuntime.itemCache.clear();
        observabilityRuntime.lastRecalledMatches = [];
        observabilityRuntime.dbSnapshot = { nodes: [], edges: [] };
        observabilityRuntime.selectedNodeKey = null;
        reconcileCurrent();
        startArchiveForCurrent();
        refreshObservabilitySnapshot({ fetchDb: true });
    });
    request('/status').then(status => {
        showStatus(status.ready ? '本机记忆库已连接' : '本机记忆库不可用', status.ready ? 'ready' : 'error');
    }).catch(() => showStatus('本机记忆库不可用', 'error'));
    startArchiveForCurrent();
    setTimeout(() => updatePillBadge(), 1200);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
} else {
    initialize();
}
