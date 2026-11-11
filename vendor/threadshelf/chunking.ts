import type { Turn } from './validation.js';
import type { Provider } from './parser.js';

const MAX_CHUNK_CHARS = Math.max(200, Number(process.env.CHUNK_MAX_CHARS) || 2000);
const OVERLAP_CHARS = Math.max(0, Number(process.env.CHUNK_OVERLAP_CHARS) || 100);

export interface Chunk {
  readonly text: string;
  readonly role: string;
  readonly turnIndex: number;
  readonly sourceFile: string;
  readonly provider: Provider | 'threadshelf';
  readonly conversationKey?: string;
  readonly title?: string;
  readonly model?: string;
  readonly createdAt?: string;
  readonly createdInThreadShelf?: boolean;
  readonly generationProvider?: string;
}

export interface ChunkMeta {
  readonly sourceFile: string;
  readonly provider: Provider | 'threadshelf';
  readonly conversationKey?: string;
  readonly title?: string;
}

export const chunkTurns = (turns: Turn[], meta: ChunkMeta): Chunk[] => {
  const chunks: Chunk[] = [];
  let turnIndex = 0;

  for (const turn of turns) {
    const role = turn.user !== undefined ? 'user' : turn.thinking !== undefined ? 'thinking' : 'ai';
    const text = turn.user ?? turn.thinking ?? turn.ai ?? '';

    if (!isIndexableText(text)) {
      turnIndex++;
      continue;
    }

    const parts = splitText(text, MAX_CHUNK_CHARS, OVERLAP_CHARS);
    for (const part of parts) {
      chunks.push({
        text: part,
        role,
        turnIndex,
        sourceFile: meta.sourceFile,
        provider: meta.provider,
        conversationKey: meta.conversationKey,
        title: meta.title,
        model: turn.model,
        createdAt: turn.createdAt,
        createdInThreadShelf: turn.createdInThreadShelf,
        generationProvider: turn.generationProvider,
      });
    }
    turnIndex++;
  }

  return chunks;
};

export const isIndexableText = (text: string | undefined | null): boolean => {
  if (!text || text === '[image]') return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed === '{}' || trimmed === '[]' || trimmed === '<') return false;
  if (/^search\(/i.test(trimmed)) return false;
  if (trimmed.length < 2) return false;
  return true;
};

const splitText = (text: string, maxChars: number, overlap: number): string[] => {
  if (text.length <= maxChars) return [text];
  const parts: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);
    if (end < text.length) {
      const breakAt = text.lastIndexOf('\n\n', end);
      if (breakAt > start) {
        end = breakAt + 2;
      } else {
        const lineBreak = text.lastIndexOf('\n', end);
        if (lineBreak > start) end = lineBreak + 1;
      }
    }
    const chunk = text.slice(start, end).trim();
    if (chunk.length > 0) parts.push(chunk);
    const nextStart = end - (end < text.length ? overlap : 0);
    start = nextStart > start ? nextStart : end;
  }

  return parts;
};
