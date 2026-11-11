export const MAX_MESSAGE_BYTES = 1024 * 1024;
export const MAX_BATCH_BYTES = 8 * 1024 * 1024;
export const MAX_BATCH_ITEMS = 2000;
const encoder = new TextEncoder();

export async function sha256Text(text) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(text));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function verifyAcknowledgments(items, acknowledgments) {
    if (!Array.isArray(acknowledgments) || acknowledgments.length !== items.length) throw new Error('memory_ack_count');
    const bySource = new Map(acknowledgments.map(ack => [ack?.source, ack]));
    if (bySource.size !== items.length) throw new Error('memory_ack_duplicate');
    for (const item of items) {
        const ack = bySource.get(item.source);
        if (!ack || ack.revision !== item.revision || !['stored', 'unchanged'].includes(ack.status) ||
            ack.sha256 !== await sha256Text(item.text)) throw new Error('memory_ack_mismatch');
    }
    return acknowledgments;
}

export function persistenceBatches(scope, items) {
    const batches = [];
    const sources = new Set();
    const overhead = encoder.encode(JSON.stringify({ ...scope, items: [] })).length;
    let batch = [], bytes = overhead;
    for (const item of items) {
        if (typeof item?.text !== 'string' || encoder.encode(item.text).length > MAX_MESSAGE_BYTES) throw new Error('memory_message_size_limit');
        if (!item.source || sources.has(item.source)) throw new Error('memory_duplicate_source');
        sources.add(item.source);
        const size = encoder.encode(JSON.stringify(item)).length;
        if (overhead + size > MAX_BATCH_BYTES) throw new Error('memory_batch_size_limit');
        if (batch.length && (batch.length >= MAX_BATCH_ITEMS || bytes + size + 1 > MAX_BATCH_BYTES)) {
            batches.push(batch); batch = []; bytes = overhead;
        }
        bytes += size + (batch.length ? 1 : 0);
        batch.push({ ...item });
    }
    if (batch.length) batches.push(batch);
    return batches;
}

export async function persistItems(scope, items, api) {
    const batches = persistenceBatches(scope, items);
    const acknowledgments = [];
    for (const batch of batches) {
        let received;
        if (typeof api.putBatch === 'function') received = (await api.putBatch(scope, batch))?.acknowledgments;
        else received = await Promise.all(batch.map(item => api.put(scope, item)));
        acknowledgments.push(...await verifyAcknowledgments(batch, received));
    }
    return acknowledgments;
}
