import type { Turn } from './validation.js';

// --- Public types ---

export interface Conversation {
  readonly key: string;
  readonly title: string;
  readonly turns: Turn[];
}

export interface ParseResult {
  readonly conversations: Conversation[];
  readonly error?: string;
}

export interface FlatParseResult {
  readonly turns: Turn[];
  readonly error?: string;
}

export interface ConversationSummary {
  readonly key: string;
  readonly title: string;
  readonly turnCount: number;
}

// --- Public API ---

export const parseExport = (input: unknown, options: ParseOptions = {}): FlatParseResult => {
  const parsed = parseConversations(input, options);
  if (parsed.error) return { turns: [], error: parsed.error };
  return { turns: parsed.conversations.flatMap((c) => c.turns) };
};

export const parseConversationGroups = (
  input: unknown,
  options: ParseOptions = {},
): ParseResult => {
  return parseConversations(input, options);
};

export const listConversationsFromExport = (
  input: unknown,
  options: ParseOptions = {},
): { conversations: ConversationSummary[]; error?: string } => {
  const parsed = parseConversations(input, options);
  if (parsed.error) return { conversations: [], error: parsed.error };
  return {
    conversations: parsed.conversations.map((c) => ({
      key: c.key,
      title: c.title,
      turnCount: c.turns.length,
    })),
  };
};

export const getConversationFromExport = (
  input: unknown,
  conversationKey: string,
  options: ParseOptions = {},
): { conversation: Conversation | null; error?: string } => {
  const parsed = parseConversations(input, options);
  if (parsed.error) return { conversation: null, error: parsed.error };

  const conversation = conversationKey
    ? parsed.conversations.find((entry) => entry.key === conversationKey)
    : parsed.conversations[0];

  if (!conversation) {
    return { conversation: null, error: `Conversation not found: ${conversationKey}` };
  }
  return { conversation };
};

export const parseFile = async (
  filePath: string,
  options: ParseOptions = {},
): Promise<FlatParseResult> => {
  const fs = await import('fs/promises');
  const content = await fs.readFile(filePath, 'utf-8');
  return parseExport(content, options);
};

export const parseGoogleAIStudio = (
  input: unknown,
  options: ParseOptions = {},
): FlatParseResult => {
  const parsed = parseInput(input);
  if (parsed.error) return { turns: [], error: parsed.error };
  const result = buildGoogleConversation(parsed.data as AnyObj, options);
  return flattenParseResult(result);
};

export const parseAnthropic = (input: unknown, options: ParseOptions = {}): FlatParseResult => {
  const parsed = parseInput(input);
  if (parsed.error) return { turns: [], error: parsed.error };
  return { turns: buildAnthropicConversations(parsed.data, options).flatMap((c) => c.turns) };
};

export const parseOpenAI = (input: unknown, options: ParseOptions = {}): FlatParseResult => {
  const parsed = parseInput(input);
  if (parsed.error) return { turns: [], error: parsed.error };
  return { turns: buildOpenAIConversations(parsed.data, options).flatMap((c) => c.turns) };
};

export const parseOpenRouter = (input: unknown, options: ParseOptions = {}): FlatParseResult => {
  const parsed = parseInput(input);
  if (parsed.error) return { turns: [], error: parsed.error };
  return flattenParseResult(buildOpenRouterConversation(parsed.data as AnyObj, options));
};

export const parseLMStudio = (input: unknown, options: ParseOptions = {}): FlatParseResult => {
  const parsed = parseInput(input);
  if (parsed.error) return { turns: [], error: parsed.error };
  return flattenParseResult(buildLMStudioConversation(parsed.data as AnyObj, options));
};

export const parseGrok = (input: unknown, options: ParseOptions = {}): FlatParseResult => {
  const parsed = parseInput(input);
  if (parsed.error) return { turns: [], error: parsed.error };
  return { turns: buildGrokConversations(parsed.data as AnyObj, options).flatMap((c) => c.turns) };
};

// --- Format detection ---

export type Provider =
  | 'google-ai-studio'
  | 'anthropic'
  | 'openai'
  | 'openrouter'
  | 'lm-studio'
  | 'grok'
  | 'unknown';

export const detectProvider = (data: unknown): Provider => {
  if (isGoogleAIStudio(data)) return 'google-ai-studio';
  if (isGrokFormat(data)) return 'grok';
  if (isAnthropicFormat(data)) return 'anthropic';
  if (isOpenAIFormat(data)) return 'openai';
  if (isOpenRouterFormat(data)) return 'openrouter';
  if (isLMStudioFormat(data)) return 'lm-studio';
  return 'unknown';
};

// --- Internal types ---

interface ParseOptions {
  readonly includeUser?: boolean;
  readonly includeThinking?: boolean;
  readonly includeAi?: boolean;
}

type AnyObj = Record<string, unknown>;

// --- Format detection helpers ---

const isGoogleAIStudio = (data: unknown): boolean => {
  const d = data as AnyObj;
  return (
    (!!d?.chunkedPrompt && Array.isArray((d.chunkedPrompt as AnyObj)?.chunks)) ||
    (!!d?.imagenPrompt && Array.isArray((d.imagenPrompt as AnyObj)?.imagenTurns))
  );
};

const isAnthropicFormat = (data: unknown): boolean => {
  if (Array.isArray(data) && data.length > 0 && (data[0] as AnyObj)?.chat_messages != null)
    return true;
  if (Array.isArray(data)) return false;
  const d = data as AnyObj;
  if (Array.isArray(d?.chat_messages)) return true;
  // Project conversation files in current Anthropic exports use
  // `{ project, messages: [{ role, content: { content } }] }` rather than the
  // top-level export's `chat_messages` array.
  if (
    d?.project &&
    typeof d.project === 'object' &&
    Array.isArray(d?.messages) &&
    (d.messages as AnyObj[]).some(
      (message) =>
        (message?.role === 'user' || message?.role === 'assistant') &&
        !!message?.content &&
        typeof message.content === 'object' &&
        typeof (message.content as AnyObj).content === 'string',
    )
  ) {
    return true;
  }
  // Some Anthropic exports wrap the conversation array in an object. The
  // builder has always supported this shape, but provider detection did not,
  // making that code path unreachable through the public parser.
  return (
    Array.isArray(d?.conversations) &&
    (d.conversations as unknown[]).some(
      (conversation) => !!conversation && Array.isArray((conversation as AnyObj).chat_messages),
    )
  );
};

const isOpenAIFormat = (data: unknown): boolean => {
  if (Array.isArray(data) && data.length > 0 && (data[0] as AnyObj)?.mapping != null) return true;
  return !Array.isArray(data) && (data as AnyObj)?.mapping != null;
};

const isOpenRouterFormat = (data: unknown): boolean => {
  const d = data as AnyObj;
  return d?.platform === 'openrouter' && Array.isArray(d?.turns);
};

// LM Studio stores one JSON file per conversation. There is no documented,
// stable schema (LM Studio's own docs say not to rely on the format), so this
// detector keys off the structural shape: a `messages` array whose entries are
// `{ versions, currentlySelected }`. Empty conversations are matched via the
// LM-Studio-specific prediction-config fields.
const isLMStudioFormat = (data: unknown): boolean => {
  if (Array.isArray(data)) return false;
  const d = data as AnyObj;
  if (!Array.isArray(d?.messages)) return false;
  const messages = d.messages as AnyObj[];
  if (messages.length === 0) {
    return 'usePerChatPredictionConfig' in d || 'perChatPredictionConfig' in d;
  }
  return messages.some(
    (msg) => Array.isArray((msg as AnyObj)?.versions) && 'currentlySelected' in (msg as AnyObj),
  );
};

// Grok (x.ai) account export. The dump is a single `prod-grok-backend.json`
// with `{ conversations, projects, tasks, media_posts }` at the root, where each
// conversation is `{ conversation: {…meta}, responses: [{ response: {…} }] }`.
// There is no documented, stable schema, so this detector keys off that nested
// shape rather than any one field.
const isGrokFormat = (data: unknown): boolean => {
  if (Array.isArray(data)) return false;
  const d = data as AnyObj;
  if (!Array.isArray(d?.conversations)) return false;
  const entries = d.conversations as AnyObj[];
  if (entries.length === 0) {
    // Empty account export: fall back to the Grok-specific sibling collections.
    return 'media_posts' in d && 'tasks' in d && 'projects' in d;
  }
  const first = entries[0] as AnyObj;
  return !!first && typeof first === 'object' && 'conversation' in first && 'responses' in first;
};

// --- Core dispatch ---

const parseInput = (input: unknown): { data: unknown; error?: string } => {
  try {
    return { data: typeof input === 'string' ? JSON.parse(input) : input };
  } catch (e) {
    return { data: undefined, error: `Invalid JSON: ${(e as Error).message}` };
  }
};

const flattenParseResult = (result: ParseResult): FlatParseResult => {
  if (result.error) return { turns: [], error: result.error };
  return { turns: result.conversations.flatMap((c) => c.turns) };
};

const parseConversations = (input: unknown, options: ParseOptions = {}): ParseResult => {
  const parsed = parseInput(input);
  if (parsed.error) return { conversations: [], error: parsed.error };
  const { data } = parsed;

  switch (detectProvider(data)) {
    case 'google-ai-studio':
      return buildGoogleConversation(data as AnyObj, options);
    case 'grok':
      return { conversations: buildGrokConversations(data as AnyObj, options) };
    case 'anthropic':
      return { conversations: buildAnthropicConversations(data, options) };
    case 'openai':
      return { conversations: buildOpenAIConversations(data, options) };
    case 'openrouter':
      return buildOpenRouterConversation(data as AnyObj, options);
    case 'lm-studio':
      return buildLMStudioConversation(data as AnyObj, options);
    case 'unknown':
      return {
        conversations: [],
        error:
          'Unknown export format (expected Google AI Studio, Anthropic, OpenAI, OpenRouter, LM Studio, or Grok)',
      };
  }
};

// --- Timestamp normalization ---

const normalizeTimestamp = (value: unknown): string | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string') {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) {
      const fromEpoch = normalizeTimestamp(asNumber);
      if (fromEpoch) return fromEpoch;
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  const ms = value < 10_000_000_000 ? value * 1000 : value;
  // Reject implausible epochs: compact date strings like "20240101120000"
  // are Number()-finite but land centuries away when read as milliseconds.
  if (ms < Date.UTC(2000, 0, 1) || ms >= Date.UTC(2100, 0, 1)) return undefined;
  return new Date(ms).toISOString();
};

const getTimestamp = (...objects: unknown[]): string | undefined => {
  for (const obj of objects) {
    const o = obj as AnyObj | undefined;
    const value =
      o?.create_time ??
      o?.created_at ??
      o?.createdAt ??
      o?.timestamp ??
      o?.time ??
      o?.date ??
      o?.update_time ??
      o?.updated_at ??
      o?.updatedAt;
    const normalized = normalizeTimestamp(value);
    if (normalized) return normalized;
  }
  return undefined;
};

const withMeta = (turn: Turn, { createdAt }: { createdAt?: string } = {}): Turn => {
  return createdAt ? { ...turn, createdAt } : turn;
};

// --- Title normalization ---

const summarizeConversationTitle = (turns: Turn[], fallback: string): string => {
  const firstText = turns
    .map((turn) => turn.user ?? turn.ai ?? turn.thinking ?? '')
    .find((text) => typeof text === 'string' && text.trim());

  if (!firstText) return fallback;
  const normalized = firstText.replace(/\s+/g, ' ').trim();
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
};

const normalizeConversationTitle = (
  rawTitle: unknown,
  fallback: string,
  turns: Turn[] = [],
): string => {
  const title = typeof rawTitle === 'string' ? rawTitle.trim() : '';
  return title || summarizeConversationTitle(turns, fallback);
};

// --- Google AI Studio ---

const buildGoogleConversation = (data: AnyObj, options: ParseOptions = {}): ParseResult => {
  const { includeUser = true, includeThinking = true, includeAi = true } = options;
  const chunks = (data?.chunkedPrompt as AnyObj)?.chunks;
  const imagenTurns = (data?.imagenPrompt as AnyObj)?.imagenTurns;
  if (Array.isArray(imagenTurns)) {
    const turns: Turn[] = [];
    const model =
      typeof (data?.runSettings as AnyObj)?.model === 'string'
        ? ((data.runSettings as AnyObj).model as string)
        : undefined;
    const defaultCreatedAt = getTimestamp(data, data?.metadata, data?.runSettings);

    for (const entry of imagenTurns) {
      const imagenTurn = entry as AnyObj;
      const createdAt = getTimestamp(imagenTurn, imagenTurn?.metadata) ?? defaultCreatedAt;
      const prompt = typeof imagenTurn?.prompt === 'string' ? imagenTurn.prompt.trim() : '';
      if (includeUser && prompt) turns.push(withMeta({ user: prompt }, { createdAt }));

      if (
        includeAi &&
        Array.isArray(imagenTurn?.generatedImages) &&
        imagenTurn.generatedImages.length > 0
      ) {
        turns.push(
          withMeta(model ? { ai: '[image]', model } : { ai: '[image]' }, {
            createdAt,
          }),
        );
      }
    }

    if (!turns.length) return { conversations: [] };
    return {
      conversations: [
        {
          key: 'google:0',
          title: normalizeConversationTitle(
            data?.title ?? data?.name ?? (data?.metadata as AnyObj)?.title,
            'Conversation 1',
            turns,
          ),
          turns,
        },
      ],
    };
  }

  if (!Array.isArray(chunks)) {
    return { conversations: [], error: 'Missing or invalid chunkedPrompt.chunks' };
  }

  const turns: Turn[] = [];
  const model =
    typeof (data?.runSettings as AnyObj)?.model === 'string'
      ? ((data.runSettings as AnyObj).model as string)
      : undefined;
  const defaultCreatedAt = getTimestamp(data, data?.metadata, data?.runSettings);

  for (const chunk of chunks) {
    const c = chunk as AnyObj;
    const role = c?.role as string;
    const createdAt = getTimestamp(c, c?.metadata) ?? defaultCreatedAt;

    if (role === 'user') {
      if (!includeUser) continue;
      const text = c.text;
      if (typeof text === 'string' && text.trim()) {
        turns.push(withMeta({ user: text.trim() }, { createdAt }));
      } else if (c.driveImage) {
        turns.push(withMeta({ user: '[image]' }, { createdAt }));
      }
      continue;
    }

    if (role === 'model') {
      const text = c.text as string;
      const isThought = c.isThought === true;
      if (isThought && includeThinking && typeof text === 'string') {
        const trimmed = text.trim();
        if (trimmed)
          turns.push(
            withMeta(model ? { thinking: trimmed, model } : { thinking: trimmed }, { createdAt }),
          );
      } else if (!isThought && includeAi && typeof text === 'string') {
        const trimmed = text.trim();
        if (trimmed)
          turns.push(withMeta(model ? { ai: trimmed, model } : { ai: trimmed }, { createdAt }));
      }
    }
  }

  if (!turns.length) return { conversations: [] };
  return {
    conversations: [
      {
        key: 'google:0',
        title: normalizeConversationTitle(
          data?.title ?? data?.name ?? (data?.metadata as AnyObj)?.title,
          'Conversation 1',
          turns,
        ),
        turns,
      },
    ],
  };
};

// --- Anthropic ---

const extractAnthropicMessageContent = (
  msg: AnyObj,
): {
  userText: string;
  thinkingTexts: string[];
  aiTexts: string[];
} => {
  const contentObject =
    msg?.content && !Array.isArray(msg.content) && typeof msg.content === 'object'
      ? (msg.content as AnyObj)
      : undefined;
  const content = Array.isArray(msg?.content)
    ? (msg.content as AnyObj[])
    : Array.isArray(contentObject?.contentBlocks)
      ? (contentObject.contentBlocks as AnyObj[])
      : [];
  const thinkingTexts: string[] = [];
  const aiTexts: string[] = [];

  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'thinking') {
      const rawThinking =
        typeof block.thinking === 'string'
          ? block.thinking
          : typeof block.text === 'string'
            ? block.text
            : '';
      const text = rawThinking.trim();
      if (text) thinkingTexts.push(text);
      continue;
    }
    if (block.type === 'text') {
      const text = typeof block.text === 'string' ? (block.text as string).trim() : '';
      if (text) aiTexts.push(text);
    }
  }

  const fallbackText =
    typeof msg?.text === 'string'
      ? (msg.text as string).trim()
      : typeof contentObject?.content === 'string'
        ? (contentObject.content as string).trim()
        : '';
  if (!contentObject && content.length === 0 && fallbackText) {
    aiTexts.push(fallbackText);
  }

  return {
    userText: contentObject
      ? fallbackText
      : content.length === 0
        ? fallbackText
        : aiTexts.join('\n\n') || fallbackText,
    thinkingTexts,
    aiTexts: contentObject
      ? fallbackText
        ? [fallbackText]
        : []
      : content.length === 0
        ? aiTexts
        : aiTexts.length
          ? aiTexts
          : fallbackText
            ? [fallbackText]
            : [],
  };
};

const buildAnthropicConversations = (data: unknown, options: ParseOptions = {}): Conversation[] => {
  const { includeUser = true, includeThinking = true, includeAi = true } = options;
  const d = data as AnyObj;
  const isProjectConversation =
    !Array.isArray(data) &&
    !!d?.project &&
    typeof d.project === 'object' &&
    Array.isArray(d?.messages);
  const sourceConversations: AnyObj[] = isProjectConversation
    ? [{ ...d, chat_messages: d.messages }]
    : Array.isArray(data)
      ? (data as AnyObj[])
      : d?.conversations
        ? (d.conversations as AnyObj[])
        : [d];
  const conversations: Conversation[] = [];

  for (const [index, conv] of sourceConversations.entries()) {
    const messages = conv?.chat_messages;
    if (!Array.isArray(messages)) continue;

    const turns: Turn[] = [];
    for (const msg of messages as AnyObj[]) {
      const sender = (msg?.sender ?? msg?.role) as string;
      const model =
        typeof msg?.model === 'string'
          ? (msg.model as string)
          : typeof msg?.model_slug === 'string'
            ? (msg.model_slug as string)
            : typeof conv?.model === 'string'
              ? (conv.model as string)
              : undefined;
      const createdAt = getTimestamp(msg) ?? getTimestamp(conv);
      const extracted = extractAnthropicMessageContent(msg);

      if ((sender === 'human' || sender === 'user') && includeUser) {
        const text = extracted.userText;
        if (text) turns.push(withMeta({ user: text }, { createdAt }));
      } else if (sender === 'assistant' || sender === 'model') {
        if (includeThinking) {
          for (const thought of extracted.thinkingTexts) {
            turns.push(
              withMeta(model ? { thinking: thought, model } : { thinking: thought }, { createdAt }),
            );
          }
        }
        if (includeAi) {
          for (const text of extracted.aiTexts) {
            turns.push(withMeta(model ? { ai: text, model } : { ai: text }, { createdAt }));
          }
        }
      }
    }

    if (!turns.length) continue;
    const rawKey = conv?.uuid ?? conv?.id ?? conv?.conversation_id ?? index;
    conversations.push({
      key: `anthropic:${String(rawKey)}`,
      title: normalizeConversationTitle(
        conv?.name ?? conv?.title,
        `Conversation ${index + 1}`,
        turns,
      ),
      turns,
    });
  }

  return conversations;
};

// --- OpenAI / ChatGPT ---

const extractOpenAIText = (content: unknown): string => {
  if (!content) return '';
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return (content as unknown[])
      .map((part) => extractOpenAIText(part))
      .filter(Boolean)
      .join('\n\n')
      .trim();
  }
  const c = content as AnyObj;
  if (typeof c.text === 'string') return (c.text as string).trim();
  if (Array.isArray(c.parts)) {
    return (c.parts as unknown[])
      .map((part) => {
        if (typeof part === 'string') return part.trim();
        if (part && typeof (part as AnyObj).text === 'string')
          return ((part as AnyObj).text as string).trim();
        return '';
      })
      .filter(Boolean)
      .join('\n\n')
      .trim();
  }
  return '';
};

const buildOpenAIPathToNode = (mapping: AnyObj, nodeId: string): AnyObj[] => {
  const chain: AnyObj[] = [];
  let cursor: string | undefined = nodeId;
  const seen = new Set<string>();
  while (cursor && mapping[cursor] && !seen.has(cursor)) {
    seen.add(cursor);
    chain.push(mapping[cursor] as AnyObj);
    cursor = (mapping[cursor] as AnyObj)?.parent as string | undefined;
  }
  return chain.reverse();
};

const getOpenAINodeCreateTime = (node: AnyObj): number => {
  const value = (node?.message as AnyObj)?.create_time;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
};

const getOpenAIConversationPath = (conversation: AnyObj): AnyObj[] => {
  const mapping = conversation?.mapping;
  if (!mapping || typeof mapping !== 'object') return [];

  const currentNodeId = conversation?.current_node;
  if (typeof currentNodeId === 'string' && (mapping as AnyObj)[currentNodeId]) {
    return buildOpenAIPathToNode(mapping as AnyObj, currentNodeId);
  }

  const nodesById = mapping as AnyObj;
  const childIds = new Set(
    (Object.values(nodesById) as AnyObj[])
      .map((node) => node?.parent)
      .filter((parent): parent is string => typeof parent === 'string'),
  );
  const timedNodes = Object.entries(nodesById)
    .filter(([, node]) => getOpenAINodeCreateTime(node as AnyObj) > 0)
    .map(([id, node]) => ({ id, node: node as AnyObj }));
  if (childIds.size === 0) {
    return timedNodes
      .map(({ node }) => node)
      .sort((a, b) => getOpenAINodeCreateTime(a) - getOpenAINodeCreateTime(b));
  }
  const leafNodes = timedNodes.filter(({ id }) => !childIds.has(id));
  const candidates = leafNodes.length ? leafNodes : timedNodes;
  const latest = candidates.sort(
    (a, b) => getOpenAINodeCreateTime(b.node) - getOpenAINodeCreateTime(a.node),
  )[0];
  return latest ? buildOpenAIPathToNode(nodesById, latest.id) : [];
};

const getOpenAIModel = (message: AnyObj | undefined, conversation: AnyObj): string | undefined => {
  if (typeof (message?.metadata as AnyObj)?.model_slug === 'string')
    return (message!.metadata as AnyObj).model_slug as string;
  if (typeof message?.model_slug === 'string') return message.model_slug as string;
  if (typeof conversation?.default_model_slug === 'string')
    return conversation.default_model_slug as string;
  return undefined;
};

const isOpenAITechnicalArtifact = (message: AnyObj, text: string): boolean => {
  const contentType = (message?.content as AnyObj)?.content_type;
  const trimmed = text.trim();
  if (trimmed === '{}' || trimmed === '<' || trimmed === '[]') return true;
  if (contentType === 'code' && /^search\(/i.test(trimmed)) return true;
  return false;
};

const buildOpenAIConversations = (data: unknown, options: ParseOptions = {}): Conversation[] => {
  const { includeUser = true, includeAi = true } = options;
  const sourceConversations: AnyObj[] = Array.isArray(data) ? (data as AnyObj[]) : [data as AnyObj];
  const conversations: Conversation[] = [];

  for (const [index, conversation] of sourceConversations.entries()) {
    const path = getOpenAIConversationPath(conversation);
    const turns: Turn[] = [];

    for (const node of path) {
      const message = node?.message as AnyObj | undefined;
      const role = (message?.author as AnyObj)?.role as string | undefined;
      const text = extractOpenAIText(message?.content);
      const model = getOpenAIModel(message, conversation);
      const createdAt = getTimestamp(message, conversation);
      if (!text) continue;
      if (role === 'assistant' && message && isOpenAITechnicalArtifact(message, text)) continue;

      if (role === 'user' && includeUser) {
        turns.push(withMeta({ user: text }, { createdAt }));
      } else if (role === 'assistant' && includeAi) {
        turns.push(withMeta(model ? { ai: text, model } : { ai: text }, { createdAt }));
      }
    }

    if (!turns.length) continue;
    const rawKey =
      conversation?.id ?? conversation?.conversation_id ?? conversation?.title ?? index;
    conversations.push({
      key: `openai:${String(rawKey)}`,
      title: normalizeConversationTitle(conversation?.title, `Conversation ${index + 1}`, turns),
      turns,
    });
  }

  return conversations;
};

// --- OpenRouter ---

const extractOpenRouterText = (turn: AnyObj): string => {
  const value = turn?.content ?? turn?.text ?? turn?.message;
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return (value as unknown[])
      .map((part) => {
        if (typeof part === 'string') return part.trim();
        if (typeof (part as AnyObj)?.text === 'string')
          return ((part as AnyObj).text as string).trim();
        if (typeof (part as AnyObj)?.content === 'string')
          return ((part as AnyObj).content as string).trim();
        return '';
      })
      .filter(Boolean)
      .join('\n\n')
      .trim();
  }
  return '';
};

const buildOpenRouterConversation = (data: AnyObj, options: ParseOptions = {}): ParseResult => {
  const { includeUser = true, includeAi = true } = options;
  const sourceTurns = Array.isArray(data?.turns) ? (data.turns as AnyObj[]) : [];
  const turns: Turn[] = [];

  for (const turn of sourceTurns) {
    const role = String(turn?.role || '').toLowerCase();
    const text = extractOpenRouterText(turn);
    if (!text) continue;
    const createdAt = getTimestamp(turn);

    if (role === 'user' && includeUser) {
      turns.push(withMeta({ user: text }, { createdAt }));
    } else if ((role === 'assistant' || role === 'model' || role === 'ai') && includeAi) {
      const model =
        typeof turn?.model === 'string' && (turn.model as string).trim()
          ? (turn.model as string).trim()
          : undefined;
      turns.push(withMeta(model ? { ai: text, model } : { ai: text }, { createdAt }));
    }
  }

  if (!turns.length) return { conversations: [] };
  return {
    conversations: [
      {
        key: 'openrouter:0',
        title: normalizeConversationTitle(data?.title ?? data?.name, 'Conversation 1', turns),
        turns,
      },
    ],
  };
};

// --- LM Studio ---

// Harmony / channel control tokens (e.g. `<|start|>assistant<|channel|>final<|message|>`)
// leak into the stored text for some local models (gpt-oss et al.). In that format the
// real content follows the last `<|message|>` marker; everything before it is role/channel
// metadata. Strip it so it does not pollute search.
const stripControlTokens = (text: string): string => {
  const marker = '<|message|>';
  const lastMessage = text.lastIndexOf(marker);
  const body = lastMessage >= 0 ? text.slice(lastMessage + marker.length) : text;
  return body.replace(/<\|[^|]*\|>/g, '').trim();
};

const extractLMStudioText = (content: unknown): string => {
  if (!Array.isArray(content)) return '';
  return (content as AnyObj[])
    .map((block) =>
      block && block.type === 'text' && typeof block.text === 'string'
        ? stripControlTokens(block.text as string)
        : '',
    )
    .filter(Boolean)
    .join('\n\n')
    .trim();
};

const buildLMStudioConversation = (data: AnyObj, options: ParseOptions = {}): ParseResult => {
  const { includeUser = true, includeThinking = true, includeAi = true } = options;
  const messages = Array.isArray(data?.messages) ? (data.messages as AnyObj[]) : [];
  const model =
    typeof (data?.lastUsedModel as AnyObj)?.identifier === 'string'
      ? ((data.lastUsedModel as AnyObj).identifier as string)
      : undefined;
  const createdAt = getTimestamp(data);
  const turns: Turn[] = [];

  for (const message of messages) {
    const versions = Array.isArray(message?.versions) ? (message.versions as AnyObj[]) : [];
    if (!versions.length) continue;
    const selected = message?.currentlySelected;
    const index = typeof selected === 'number' && versions[selected] ? (selected as number) : 0;
    const version = versions[index];
    const role = version?.role as string;

    if (role === 'user') {
      if (!includeUser) continue;
      const text = extractLMStudioText(version?.content);
      if (text) turns.push(withMeta({ user: text }, { createdAt }));
      continue;
    }

    if (role !== 'assistant') continue;
    const senderName = (version?.senderInfo as AnyObj | undefined)?.senderName;
    const messageModel =
      typeof senderName === 'string' && senderName.trim() ? senderName.trim() : model;

    // multiStep assistant messages split reasoning ("thinking") and answer into
    // separate steps; singleStep messages carry text directly on `content`.
    const steps = Array.isArray(version?.steps) ? (version.steps as AnyObj[]) : null;
    if (!steps) {
      const text = extractLMStudioText(version?.content);
      if (text && includeAi) {
        turns.push(
          withMeta(messageModel ? { ai: text, model: messageModel } : { ai: text }, { createdAt }),
        );
      }
      continue;
    }

    for (const step of steps) {
      if (step?.type !== 'contentBlock') continue; // skip debugInfoBlock and friends
      const text = extractLMStudioText(step?.content);
      if (!text) continue;
      const isThought = (step?.style as AnyObj)?.type === 'thinking';
      if (isThought) {
        if (includeThinking) {
          turns.push(
            withMeta(messageModel ? { thinking: text, model: messageModel } : { thinking: text }, {
              createdAt,
            }),
          );
        }
      } else if (includeAi) {
        turns.push(
          withMeta(messageModel ? { ai: text, model: messageModel } : { ai: text }, { createdAt }),
        );
      }
    }
  }

  if (!turns.length) return { conversations: [] };
  return {
    conversations: [
      {
        key: 'lmstudio:0',
        title: normalizeConversationTitle(data?.name, 'Conversation 1', turns),
        turns,
      },
    ],
  };
};

// --- Grok (x.ai) ---

// Grok stores timestamps as MongoDB extended JSON, e.g.
// `{ "$date": { "$numberLong": "1772641368389" } }` (sometimes `{ "$date": <ms|iso> }`).
// Unwrap to a value `normalizeTimestamp` understands.
const unwrapGrokDate = (value: unknown): unknown => {
  if (value && typeof value === 'object' && '$date' in (value as AnyObj)) {
    const inner = (value as AnyObj).$date;
    if (inner && typeof inner === 'object' && '$numberLong' in (inner as AnyObj)) {
      return (inner as AnyObj).$numberLong;
    }
    return inner;
  }
  return value;
};

const grokTimestamp = (response: AnyObj): string | undefined =>
  normalizeTimestamp(unwrapGrokDate(response?.create_time));

// Grok keeps the model's reasoning in `agent_thinking_traces: [{ thinking_trace }]`.
const extractGrokThinking = (response: AnyObj): string => {
  const traces = Array.isArray(response?.agent_thinking_traces)
    ? (response.agent_thinking_traces as AnyObj[])
    : [];
  return traces
    .map((trace) => (typeof trace?.thinking_trace === 'string' ? trace.thinking_trace.trim() : ''))
    .filter(Boolean)
    .join('\n\n')
    .trim();
};

const buildGrokConversations = (data: AnyObj, options: ParseOptions = {}): Conversation[] => {
  const { includeUser = true, includeThinking = true, includeAi = true } = options;
  const entries = Array.isArray(data?.conversations) ? (data.conversations as AnyObj[]) : [];
  const conversations: Conversation[] = [];

  for (const [index, entry] of entries.entries()) {
    const meta = (entry?.conversation as AnyObj) ?? {};
    const responses = Array.isArray(entry?.responses) ? (entry.responses as AnyObj[]) : [];
    const turns: Turn[] = [];

    for (const wrapper of responses) {
      const response = (wrapper?.response as AnyObj) ?? {};
      const sender = String(response?.sender || '').toLowerCase();
      const message = typeof response?.message === 'string' ? response.message.trim() : '';
      const createdAt = grokTimestamp(response) ?? grokTimestamp(meta);

      if (sender === 'human') {
        if (includeUser && message) turns.push(withMeta({ user: message }, { createdAt }));
        continue;
      }

      // Everything else is an assistant turn (sender is "assistant"/"ASSISTANT").
      const model =
        typeof response?.model === 'string' && response.model.trim()
          ? (response.model as string).trim()
          : undefined;

      if (includeThinking) {
        const thinking = extractGrokThinking(response);
        if (thinking) {
          turns.push(withMeta(model ? { thinking, model } : { thinking }, { createdAt }));
        }
      }
      if (includeAi && message) {
        turns.push(withMeta(model ? { ai: message, model } : { ai: message }, { createdAt }));
      }
    }

    if (!turns.length) continue;
    const rawKey = meta?.id ?? meta?.conversation_id ?? index;
    conversations.push({
      key: `grok:${String(rawKey)}`,
      title: normalizeConversationTitle(meta?.title, `Conversation ${index + 1}`, turns),
      turns,
    });
  }

  return conversations;
};
