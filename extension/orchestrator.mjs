import { taggedMessages } from './client.mjs';
import { persistItems } from './persistence.mjs';

export async function syncTagged(scope, messages, api) {
    const tagged = taggedMessages(messages);
    const known = await api.manifest(scope);
    const delta = tagged.filter(item => known[item.source] === undefined || known[item.source] <= item.revision);
    await persistItems(scope, delta, api);
    await api.reconcile(scope, tagged.map(item => item.source));
    return tagged.length;
}
