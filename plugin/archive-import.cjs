const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { readHistory } = require('./history-file.cjs');

function createArchiveImporter({ controller, salt, makeScopes, fileDelayMs = 250, minScanMs = 300000 }) {
    const jobs = new Map();
    let queue = Promise.resolve();
    let stopped = false;
    const hash = value => crypto.createHmac('sha256', salt).update(value).digest('hex');
    const emptyStatus = () => ({
        phase: 'idle', totalFiles: 0, importedFiles: 0, skippedFiles: 0,
        removedFiles: 0, failedFiles: 0, messages: 0,
    });

    function resolveCard(user, avatar, world) {
        if (typeof avatar !== 'string' || avatar.length > 180 || !/^[^\\/]+\.png$/i.test(avatar) ||
            avatar === '..png' || typeof world !== 'string' || world.length > 256 ||
            !(world === `character:${avatar}` || /^manual:.{1,120}$/.test(world))) {
            throw new Error('invalid_card');
        }
        const characterRoot = user?.directories?.characters;
        const chatsRoot = user?.directories?.chats;
        if (typeof characterRoot !== 'string' || typeof chatsRoot !== 'string') {
            throw new Error('invalid_card');
        }
        const identity = `character:${avatar}`;
        const scopes = makeScopes(user, world, `${identity}:archive`, salt);
        const card = hash(`card\0${scopes.user_scope}\0${avatar}`);
        const key = `${scopes.user_scope}:${scopes.world}:${card}`;
        const cardFile = path.join(characterRoot, avatar);
        const chatsDirectory = path.join(chatsRoot, avatar.replace(/\.png$/i, ''));
        return { avatar, world, identity, scopes, card, key, cardFile, chatsDirectory };
    }

    function publicStatus(job) {
        if (!job) return emptyStatus();
        return {
            phase: job.phase,
            totalFiles: job.totalFiles,
            importedFiles: job.importedFiles,
            skippedFiles: job.skippedFiles,
            removedFiles: job.removedFiles,
            failedFiles: job.failedFiles,
            messages: job.messages,
        };
    }

    async function fileStamp(filename) {
        const stat = await fs.promises.stat(filename, { bigint: true });
        if (!stat.isFile()) throw new Error('archive_not_file');
        return `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    }

    async function importFile(context, filename, chat, stamp, job) {
        const { user_scope, world } = context.scopes;
        const known = await controller.call('manifest', { user_scope, chat });
        const items = await readHistory(filename, chat, known, () => stopped || job.cancelled);
        if (await fileStamp(filename) !== stamp || stopped || job.cancelled) throw new Error('archive_changed_during_import');
        if (items.length) await controller.call('put_batch_confirmed', { user_scope, world, chat, items }, 60000);
        await controller.call('archive_mark', { user_scope, world, card: context.card, chat, stamp, source_count: items.length }, 30000);
        job.messages += items.length;
    }
    async function run(context, job) {
        job.phase = 'running';
        const { user_scope, world } = context.scopes;
        const states = await controller.call('archive_states', { user_scope, world, card: context.card });
        if (stopped || job.cancelled) {
            job.phase = 'paused';
            return;
        }
        let entries = [];
        try {
            entries = (await fs.promises.readdir(context.chatsDirectory, { withFileTypes: true }))
                .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl'))
                .sort((a, b) => b.name.localeCompare(a.name));
        } catch (error) {
            throw error;
        }
        job.totalFiles = entries.length;
        const seen = new Set();
        for (const entry of entries) {
            if (stopped || job.cancelled) break;
            const fileId = entry.name.slice(0, -6);
            const scope = makeScopes(
                { profile: { handle: context.handle } }, context.world,
                `${context.identity}:${fileId}`, salt,
            );
            const chat = scope.chat;
            seen.add(chat);
            const filename = path.join(context.chatsDirectory, entry.name);
            try {
                const stamp = await fileStamp(filename);
                if (states[chat]?.stamp === stamp) {
                    job.skippedFiles++;
                } else {
                    await importFile(context, filename, chat, stamp, job);
                    job.importedFiles++;
                }
            } catch {
                if (stopped || job.cancelled) break;
                job.failedFiles++;
            }
            if (fileDelayMs > 0) await new Promise(resolve => setTimeout(resolve, fileDelayMs));
        }
        // Missing files are retained; only an explicit scoped operation may remove evidence.
        job.phase = stopped || job.cancelled ? 'paused' : job.failedFiles ? 'error' : 'ready';
    }

    async function start(user, avatar, world, { force = false } = {}) {
        if (stopped) throw new Error('archive_unavailable');
        const context = resolveCard(user, avatar, world);
        try {
            const stat = await fs.promises.lstat(context.cardFile);
            if (!stat.isFile()) throw new Error('invalid_card');
            try {
                const chatsStat = await fs.promises.lstat(context.chatsDirectory);
                if (!chatsStat.isDirectory()) throw new Error('invalid_card');
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }
        } catch {
            throw new Error('invalid_card');
        }
        const previous = jobs.get(context.key);
        if (previous && ['queued', 'running'].includes(previous.phase)) return publicStatus(previous);
        if (previous && !force && Date.now() - previous.startedAt < minScanMs) return publicStatus(previous);
        const job = { ...emptyStatus(), phase: 'queued', startedAt: Date.now() };
        jobs.set(context.key, job);
        context.handle = user.profile.handle;
        queue = queue.catch(() => undefined).then(async () => {
            try { await run(context, job); } catch { job.phase = 'error'; job.failedFiles++; }
        });
        return publicStatus(job);
    }

    function status(user, avatar, world) {
        const context = resolveCard(user, avatar, world);
        return publicStatus(jobs.get(context.key));
    }

    async function pause(user, avatar, world) {
        const context = resolveCard(user, avatar, world);
        const job = jobs.get(context.key);
        if (job && ['queued', 'running'].includes(job.phase)) {
            job.cancelled = true;
            job.phase = 'pausing';
        }
        return publicStatus(job);
    }

    async function stop() {
        stopped = true;
        await queue.catch(() => undefined);
    }

    return { start, status, pause, idle: () => queue, stop };
}

module.exports = { createArchiveImporter };
