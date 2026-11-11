const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createArchiveImporter } = require('./archive-import.cjs');
const { mountLibraryRoutes } = require('./library-routes.cjs');

const info = {
    id: 'long-memory-bridge',
    name: 'Long Memory Bridge',
    description: 'Local, durable, source-aware memory for SillyTavern.',
};

function createController({ dbPath, workerPath, python = process.env.LONG_MEMORY_PYTHON || 'python' }) {
    let child = null;
    let starting = null;
    let buffer = '';
    let sequence = 0;
    const pending = new Map();

    function rejectPending(error) {
        for (const item of pending.values()) {
            clearTimeout(item.timer);
            item.reject(error);
        }
        pending.clear();
    }

    function onLine(line, readyResolve, readyReject) {
        let message;
        try {
            message = JSON.parse(line);
        } catch {
            readyReject(new Error('worker_protocol_error'));
            return;
        }
        if (message.id === 0 && message.ready === true) {
            readyResolve();
            return;
        }
        const item = pending.get(message.id);
        if (!item) return;
        pending.delete(message.id);
        clearTimeout(item.timer);
        if (message.ok) item.resolve(message.result);
        else item.reject(new Error(message.error || 'worker_error'));
    }

    async function start() {
        if (child && !starting) return;
        if (starting) return starting;
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
        starting = new Promise((resolve, reject) => {
            let settled = false;
            const readyResolve = () => {
                if (settled) return;
                settled = true;
                clearTimeout(readyTimer);
                resolve();
            };
            const readyReject = error => {
                if (settled) return;
                settled = true;
                clearTimeout(readyTimer);
                reject(error);
            };
            const current = spawn(python, ['-u', '-X', 'utf8', workerPath, '--db', dbPath], {
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
            });
            child = current;
            const readyTimer = setTimeout(() => {
                current.kill();
                readyReject(new Error('worker_start_timeout'));
            }, 10000);
            current.stdout.setEncoding('utf8');
            current.stdout.on('data', chunk => {
                buffer += chunk;
                if (Buffer.byteLength(buffer, 'utf8') > 160 * 1024 * 1024) {
                    current.kill();
                    readyReject(new Error('worker_protocol_error'));
                    return;
                }
                let newline;
                while ((newline = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.slice(0, newline);
                    buffer = buffer.slice(newline + 1);
                    onLine(line, readyResolve, readyReject);
                }
            });
            current.stderr.on('data', () => {}); // Never log private message content.
            current.on('error', error => readyReject(new Error(`worker_spawn_${error.code || 'error'}`)));
            current.on('close', () => {
                if (child === current) child = null;
                buffer = '';
                readyReject(new Error('worker_exited'));
                rejectPending(new Error('worker_exited'));
            });
        });
        try {
            await starting;
        } finally {
            starting = null;
        }
    }

    async function call(op, args = {}, timeoutMs = 15000) {
        const payload = JSON.stringify({ op, args });
        if (Buffer.byteLength(payload, 'utf8') > 160 * 1024 * 1024) throw new Error('invalid_request_too_large');
        await start();
        if (!child || pending.size >= 128) throw new Error('worker_busy');
        const id = ++sequence;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(id);
                // Do not kill the worker on a transient timeout; subsequent responses for dropped IDs are cleanly ignored
                reject(new Error('worker_timeout'));
            }, timeoutMs);
            pending.set(id, { resolve, reject, timer });
            child.stdin.write(JSON.stringify({ id, op, args }) + '\n', error => {
                if (error && pending.has(id)) {
                    clearTimeout(timer);
                    pending.delete(id);
                    reject(new Error('worker_write_error'));
                }
            });
        });
    }

    async function stop() {
        if (!child) return;
        const current = child;
        try {
            await call('stop', {}, 3000);
        } catch {
            current.kill();
        }
        await new Promise(resolve => {
            if (current.exitCode !== null || current.killed) return resolve();
            const timer = setTimeout(() => {
                current.kill();
                resolve();
            }, 1500);
            current.once('close', () => {
                clearTimeout(timer);
                resolve();
            });
        });
    }

    return { start, call, stop };
}

function makeScopes(user, world, chat, salt) {
    const handle = user?.profile?.handle;
    if (typeof handle !== 'string' || !handle || handle.length > 4096 || /[\x00-\x1f]/.test(handle) ||
        typeof world !== 'string' || !world || world.length > 4096 ||
        typeof chat !== 'string' || !chat || chat.length > 8192 || /[\x00-\x1f]/.test(world) || /[\x00-\x1f]/.test(chat)) {
        throw new Error('invalid_scope');
    }
    const hash = value => crypto.createHmac('sha256', salt).update(value).digest('hex');
    const userScope = hash(`user\0${handle}`);
    return {
        user_scope: userScope,
        world: hash(`world\0${userScope}\0${world}`),
        chat: hash(`chat\0${userScope}\0${world}\0${chat}`),
    };
}

function mountRouter(router, controller, salt, importer) {
    mountLibraryRoutes(router, controller, salt, makeScopes);
    const route = (handler) => async (req, res) => {
        try {
            if (!req.user?.profile?.handle) throw new Error('invalid_scope');
            await handler(req, res);
        } catch (error) {
            const invalid = error.message?.startsWith('invalid_') || error.message === 'revision conflict';
            res.status(invalid ? 400 : 503).json({ error: invalid ? 'invalid_request' : 'memory_unavailable' });
        }
    };
    router.get('/status', route(async (_req, res) => {
        const status = await controller.call('status', {}, 5000);
        res.json({ ready: status.ready, backend: status.backend });
    }));
    router.post('/put', route(async (req, res) => {
        const { world, chat, source, revision, text, role } = req.body || {};
        const scopes = makeScopes(req.user, world, chat, salt);
        if (typeof source !== 'string' || source.length < 1 || source.length > 160 ||
            !Number.isSafeInteger(revision) || revision < 1 ||
            typeof text !== 'string' || !text.trim() || Buffer.byteLength(text, 'utf8') > 1024 * 1024 ||
            !['user', 'assistant'].includes(role)) throw new Error('invalid_input');
        const status = await controller.call('put_confirmed', { ...scopes, source, revision, text, role }, 20000);
        res.json({ status });
    }));
    router.post('/put_batch', route(async (req, res) => {
        const { world, chat, items } = req.body || {};
        const scopes = makeScopes(req.user, world, chat, salt);
        if (!Array.isArray(items) || items.length > 2000 || Buffer.byteLength(JSON.stringify(items), 'utf8') > 8 * 1024 * 1024) throw new Error('invalid_input');
        const acknowledgments = await controller.call('put_batch_confirmed', { ...scopes, items }, 30000);
        res.json({ applied: acknowledgments.length, acknowledgments });
    }));
    router.post('/reconcile', route(async (req, res) => {
        const { world, chat, presentSources } = req.body || {};
        const scopes = makeScopes(req.user, world, chat, salt);
        if (!Array.isArray(presentSources) || presentSources.length > 50000 ||
            !presentSources.every(x => typeof x === 'string' && x.length > 0 && x.length <= 160)) {
            throw new Error('invalid_input');
        }
        const removed = await controller.call('reconcile', {
            user_scope: scopes.user_scope, chat: scopes.chat, present_sources: presentSources,
        }, 30000);
        res.json({ removed });
    }));
    router.post('/manifest', route(async (req, res) => {
        const { world, chat } = req.body || {};
        const scopes = makeScopes(req.user, world, chat, salt);
        const revisions = await controller.call('manifest', { user_scope: scopes.user_scope, chat: scopes.chat }, 15000);
        res.json({ revisions });
    }));
    router.post('/recall', route(async (req, res) => {
        const { world, chat, query, excludeSources } = req.body || {};
        const scopes = makeScopes(req.user, world, chat, salt);
        if (typeof query !== 'string' || query.length > 4000) throw new Error('invalid_input');
        const exclude_sources = Array.isArray(excludeSources)
            ? excludeSources.filter(x => typeof x === 'string' && x.length > 0 && x.length <= 160).slice(0, 5000)
            : [];
        const matches = await controller.call('recall', {
            ...scopes, query, limit: 6, max_chars: 1800, exclude_sources,
        }, 20000);
        res.json({ matches });
    }));
    router.post('/inspect', route(async (req, res) => {
        const { world, chat, limit = 48 } = req.body || {};
        const scopes = makeScopes(req.user, world, chat, salt);
        const safeLimit = Number.isFinite(Number(limit)) ? Math.max(10, Math.min(Number(limit), 80)) : 48;
        const snapshot = await controller.call('inspect_scope', {
            ...scopes, limit: safeLimit,
        }, 15000);
        res.json(snapshot);
    }));
    router.post('/item', route(async (req, res) => {
        const { world, chat, source, itemChat } = req.body || {};
        const scopes = makeScopes(req.user, world, chat, salt);
        if (typeof source !== 'string' || source.length < 1 || source.length > 160) throw new Error('invalid_input');
        if (itemChat !== undefined && (typeof itemChat !== 'string' || !/^[a-f0-9]{64}$/.test(itemChat))) throw new Error('invalid_input');
        const item = await controller.call('get_item', {
            user_scope: scopes.user_scope, world: scopes.world, chat: itemChat || scopes.chat, source,
        }, 10000);
        res.json({ item });
    }));
    router.post('/archive/start', route(async (req, res) => {
        if (!importer) throw new Error('archive_unavailable');
        const { avatar, world, force = false } = req.body || {};
        if (typeof force !== 'boolean') throw new Error('invalid_input');
        res.json(await importer.start(req.user, avatar, world, { force }));
    }));
    router.post('/archive/status', route(async (req, res) => {
        if (!importer) throw new Error('archive_unavailable');
        const { avatar, world } = req.body || {};
        res.json(importer.status(req.user, avatar, world));
    }));
    router.post('/archive/pause', route(async (req, res) => {
        if (!importer) throw new Error('archive_unavailable');
        const { avatar, world } = req.body || {};
        res.json(await importer.pause(req.user, avatar, world));
    }));
}

function readOrCreateSalt(filename) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    try {
        fs.writeFileSync(filename, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 });
    } catch (error) {
        if (error.code !== 'EEXIST') throw error;
    }
    const salt = fs.readFileSync(filename);
    if (salt.length !== 32) throw new Error('invalid_salt');
    return salt;
}

let defaultController;
let defaultImporter;
async function init(router) {
    const dataRoot = typeof globalThis.DATA_ROOT === 'string' ? globalThis.DATA_ROOT : __dirname;
    const state = process.env.LONG_MEMORY_STATE_DIR || path.join(dataRoot, 'long-memory-bridge');
    const salt = readOrCreateSalt(path.join(state, 'scope.key'));
    defaultController = createController({
        dbPath: path.join(state, 'memory.sqlite3'),
        workerPath: path.join(__dirname, 'memory_worker.py'),
    });
    defaultImporter = createArchiveImporter({ controller: defaultController, salt, makeScopes });
    mountRouter(router, defaultController, salt, defaultImporter);
    try {
        await defaultController.start();
    } catch (error) {
        console.error(`Long Memory worker unavailable: ${error.message}`);
    }
}

async function exit() {
    await defaultImporter?.stop();
    await defaultController?.stop();
}

module.exports = { info, init, exit, createController, mountRouter, makeScopes };
