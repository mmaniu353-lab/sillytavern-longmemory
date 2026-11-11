import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const { normalizeInput } = require('../plugin/normalize.cjs');
const { detectProvider, parseConversationGroups } = require('../plugin/threadshelf.cjs');
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
const unicode = '汉字 日本語 e\u0301 ñ ç ü مرحبا 👩🏽‍💻 🧪';
const user = `Synthetic prompt: ${unicode}\nSecond line.`;
const answer = `Synthetic answer: ${unicode}\nFinal line.`;
const thinking = 'SYNTHETIC_THINKING_NOT_SEARCHABLE';
const alternate = 'SYNTHETIC_ALTERNATE_NOT_SEARCHABLE';
const media = 'https://invalid.example/synthetic-attachment.png';
const textBlock = text => ({ type: 'text', text });
const openaiMessage = (role, text) => ({ author: { role }, content: { content_type: 'text', parts: [text] } });
const openai = (id = 'synthetic-openai') => ({
    id, title: `Synthetic ${id}`, current_node: 'selected', default_model_slug: 'synthetic-default',
    mapping: {
        root: { id: 'root', parent: null, children: ['user'] },
        user: { id: 'user', parent: 'root', children: ['alternate', 'selected'], message: openaiMessage('user', user) },
        alternate: { id: 'alternate', parent: 'user', children: [], message: openaiMessage('assistant', alternate) },
        selected: { id: 'selected', parent: 'user', children: [], message: { ...openaiMessage('assistant', answer), metadata: { model_slug: 'synthetic-selected' }, attachments: [{ url: media }] } },
    },
});
const claude = (id = 'synthetic-claude') => ({ uuid: id, name: `Synthetic ${id}`, chat_messages: [
    { uuid: 'u', sender: 'human', text: user },
    { uuid: 'a', sender: 'assistant', model: 'synthetic-claude-model', content: [{ type: 'thinking', thinking }, textBlock(answer), { type: 'image', source: { type: 'url', url: media } }] },
] });
const lmstudio = () => ({ name: 'Synthetic LM Studio', createdAt: 1770508800000, lastUsedModel: { identifier: 'synthetic-fallback' }, usePerChatPredictionConfig: true, messages: [
    { currentlySelected: 0, versions: [{ type: 'singleStep', role: 'user', content: [textBlock(user)] }] },
    { currentlySelected: 1, versions: [
        { type: 'multiStep', role: 'assistant', steps: [{ type: 'contentBlock', content: [textBlock(alternate)] }] },
        { type: 'multiStep', role: 'assistant', senderInfo: { senderName: 'synthetic-selected' }, steps: [
            { type: 'status', status: 'loading' },
            { type: 'debugInfoBlock', content: [textBlock('SYNTHETIC_DEBUG_NOT_SEARCHABLE')] },
            { type: 'contentBlock', style: { type: 'thinking' }, content: [textBlock(thinking)] },
            { type: 'contentBlock', content: [textBlock(answer), { type: 'image', url: media }] },
            { type: 'citationBlock', content: [textBlock('SYNTHETIC_CITATION_NOT_SEARCHABLE')] },
        ] },
    ] },
] });
const google = () => ({ title: 'Synthetic AI Studio', runSettings: { model: 'models/synthetic-gemini' }, chunkedPrompt: { chunks: [
    { role: 'user', text: user }, { role: 'model', isThought: true, text: thinking },
    { role: 'model', text: answer, driveImage: { id: 'synthetic-image', url: media } },
] } });
const openrouter = () => ({ platform: 'openrouter', exportedAt: '2026-05-05T00:00:00Z', pageTitle: 'Synthetic OpenRouter', sourceUrl: 'https://openrouter.ai/chat/synthetic', turns: [
    { role: 'user', content: user }, { role: 'assistant', model: 'synthetic/model', content: [textBlock(answer), { type: 'image_url', image_url: { url: media } }] },
] });
const grok = (id = 'synthetic-grok') => ({ conversation: { id, conversation_id: id, title: `Synthetic ${id}`, create_time: { $date: { $numberLong: '1771000000000' } } }, responses: [
    { response: { _id: 'u', sender: 'human', message: user, create_time: { $date: { $numberLong: '1771000000000' } } } },
    { response: { _id: 'a', sender: 'ASSISTANT', message: answer, model: 'synthetic-grok-model', parent_response_id: 'u', create_time: { $date: { $numberLong: '1771000060000' } }, agent_thinking_traces: [{ thinking_trace: thinking }], attachments: [{ url: media }] } },
] });

// Structural references: ThreadShelf synthetic openai-polish, anthropic-polish,
// lmstudio-versions-snapshot, gemini-polish, openrouter-polish and grok-polish.
// Content is generated here; tests never load private files or fixture payloads.
const cases = [
    ['openai', () => [openai()], 'synthetic-selected'], ['anthropic', () => [claude()], 'synthetic-claude-model'], ['lm-studio', lmstudio, 'synthetic-selected'],
    ['google-ai-studio', google, 'models/synthetic-gemini'], ['openrouter', openrouter, 'synthetic/model'],
    ['grok', () => ({ conversations: [grok()], projects: [], tasks: [], media_posts: [] }), 'synthetic-grok-model'],
];

for (const [provider, fixture, model] of cases) {
    test(`${provider}: actual supported structure, exact Unicode text and honest projection warning`, () => {
        const value = fixture();
        assert.equal(detectProvider(value), provider);
        const parsed = parseConversationGroups(value, { includeUser: true, includeAi: true, includeThinking: false });
        assert.equal(parsed.error, undefined);
        assert.deepEqual(parsed.conversations.flatMap(group => group.turns.map(turn => turn.user ?? turn.ai)), [user, answer]);
        const raw = JSON.stringify(value, null, 2) + '\n';
        const result = normalizeInput({ name: `synthetic-${provider}.json`, raw });
        assert.equal(result.documents.length, 1);
        const doc = result.documents[0];
        assert.equal(doc.format, provider);
        assert.equal(doc.raw, raw);
        assert.equal(doc.sha256, sha256(raw));
        assert.equal(result.rawSha256, sha256(raw));
        assert.equal(doc.parserRevision, 'f13b721561305c3b040dc701ce86553ec36c4447');
        assert.deepEqual(doc.messages.map(message => [message.role, message.text]), [['user', user], ['assistant', answer]]);
        assert.equal(doc.messages[1].meta.model, model);
        if (provider === 'grok') {
            assert.equal(doc.messages[0].meta.createdAt, '2026-02-13T16:26:40.000Z');
            assert.equal(doc.messages[1].meta.createdAt, '2026-02-13T16:27:40.000Z');
        }
        assert.ok(doc.messages.every(message => !message.text.includes('NOT_SEARCHABLE')));
        const warnings = doc.warnings.join(' ');
        assert.match(warnings, /selected.branch/i);
        assert.match(warnings, /thinking excluded/i);
        assert.match(warnings, /branches\/media\/unsupported fields remain in raw evidence/i);
        assert.match(warnings, /not necessarily searchable/i);
        assert.ok(raw.includes(media));
    });
}

test('OpenAI current_node changes projection, not canonical evidence or alternate branch retention', () => {
    const data = openai();
    const selected = normalizeInput({ name: 'synthetic-openai.json', raw: JSON.stringify([data]) }).documents[0];
    assert.equal(selected.messages[1].text, answer);
    assert.ok(selected.raw.includes(alternate));
    data.current_node = 'alternate';
    const other = normalizeInput({ name: 'synthetic-openai.json', raw: JSON.stringify([data]) }).documents[0];
    assert.equal(other.messages[1].text, alternate);
    assert.equal(other.id, selected.id);
    assert.notEqual(other.sha256, selected.sha256);
});

test('LM Studio currentlySelected controls answer while debug, thinking and other versions remain raw only', () => {
    const data = lmstudio();
    const selected = normalizeInput({ name: 'synthetic-lmstudio.json', raw: JSON.stringify(data) }).documents[0];
    assert.deepEqual(selected.messages.map(message => message.text), [user, answer]);
    for (const marker of [alternate, thinking, 'SYNTHETIC_DEBUG_NOT_SEARCHABLE', 'SYNTHETIC_CITATION_NOT_SEARCHABLE']) {
        assert.ok(selected.raw.includes(marker));
        assert.ok(selected.messages.every(message => !message.text.includes(marker)));
    }
    data.messages[1].currentlySelected = 0;
    assert.equal(normalizeInput({ name: 'synthetic-lmstudio.json', raw: JSON.stringify(data) }).documents[0].messages[1].text, alternate);
});

test('Claude project nested content.content uses provider parser rather than generic messages shortcut', () => {
    const data = { uuid: 'synthetic-project-chat', title: 'Synthetic Claude project', project: { uuid: 'synthetic-project' }, messages: [
        { role: 'user', content: { content: user, timestamp: '2026-06-10T08:00:00Z' } },
        { role: 'assistant', content: { content: answer, contentBlocks: [{ type: 'thinking', text: thinking }, textBlock(answer)] } },
    ] };
    assert.equal(detectProvider(data), 'anthropic');
    const doc = normalizeInput({ name: 'synthetic-project.json', raw: JSON.stringify(data) }).documents[0];
    assert.equal(doc.format, 'anthropic');
    assert.deepEqual(doc.messages.map(message => message.text), [user, answer]);
});

test('OpenAI, Claude and Grok parser groups remain independent documents instead of flattened turns', () => {
    for (const value of [[openai('one'), openai('two')], [claude('one'), claude('two')], { conversations: [grok('one'), grok('two')], projects: [], tasks: [], media_posts: [] }]) {
        const parsed = parseConversationGroups(value, { includeThinking: false });
        assert.equal(parsed.conversations.length, 2);
        assert.equal(new Set(parsed.conversations.map(group => group.key)).size, 2);
        const raw = JSON.stringify(value);
        const docs = normalizeInput({ name: 'synthetic-groups.json', raw }).documents;
        assert.equal(docs.length, 2);
        assert.notEqual(docs[0].id, docs[1].id);
        for (const doc of docs) {
            assert.deepEqual(doc.messages.map(message => message.text), [user, answer]);
            assert.equal(doc.raw, raw);
            assert.equal(doc.sha256, sha256(raw));
        }
    }
});

test('canonical evidence loses no character even when text projection trims boundary whitespace', () => {
    const data = google();
    data.chunkedPrompt.chunks[0].text = ' \t' + user + '\r\n ';
    const raw = '\n  ' + JSON.stringify(data, null, '\t') + '\r\n';
    const doc = normalizeInput({ name: 'synthetic-whitespace.json', raw }).documents[0];
    assert.equal(doc.raw, raw);
    assert.deepEqual(Buffer.from(doc.raw, 'utf8'), Buffer.from(raw, 'utf8'));
    assert.equal(doc.sha256, sha256(raw));
    assert.equal(doc.messages[0].text, user);
    assert.match(doc.warnings.join(' '), /projection/i);
});

test('unsupported JSON structures and empty pseudo-provider exports are explicitly rejected', () => {
    for (const value of [{}, [], { arbitrary: 'text' }, { conversations: [] }, { platform: 'openrouter', turns: [] }, { chunkedPrompt: { chunks: [] } }, { messages: [{ unsupportedBlock: { text: answer } }] }]) {
        assert.throws(() => normalizeInput({ name: 'synthetic-unsupported.json', raw: JSON.stringify(value) }), /invalid_/);
    }
});
