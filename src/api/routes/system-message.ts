import type { ContentBlock } from '@/types/cma-protocol.js';

/**
 * Documented maximum number of text items in one `system.message`.
 *
 * The published contract states `content` accepts 1–1000 text items. Enforcing
 * the bound here means an over-long batch is refused before it reaches the
 * append-only log, where it would be permanent.
 */
export const MAX_SYSTEM_MESSAGE_BLOCKS = 1000;

/**
 * Validate the public system.message payload without trusting client-supplied
 * event identity or metadata. System messages use the same content-block
 * vocabulary as user messages, but must contain at least one meaningful block.
 */
export function normalizeSystemMessageContent(value: unknown): ContentBlock[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (value.length > MAX_SYSTEM_MESSAGE_BLOCKS) return null;
  return value.every(isValidContentBlock) ? value as ContentBlock[] : null;
}

/** Distinguish "too many blocks" from "malformed" so the API can say which. */
export function systemMessageContentError(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return 'system.message content must be a non-empty array of valid content blocks';
  }
  if (value.length > MAX_SYSTEM_MESSAGE_BLOCKS) {
    return `system.message content accepts at most ${MAX_SYSTEM_MESSAGE_BLOCKS} blocks (received ${value.length})`;
  }
  return undefined;
}

function isValidContentBlock(value: unknown): value is ContentBlock {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const block = value as Record<string, unknown>;
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' && block.text.trim().length > 0;
    case 'image':
      return isValidSource(block.source, ['base64', 'url', 'file'], 'image');
    case 'document':
      return isValidSource(block.source, ['base64', 'url', 'file', 'text'], 'document');
    case 'tool_use':
      return nonEmptyString(block.id)
        && nonEmptyString(block.name)
        && isRecord(block.input);
    case 'tool_result':
      return nonEmptyString(block.tool_use_id)
        && (typeof block.content === 'string'
          || (Array.isArray(block.content)
            && block.content.length > 0
            && block.content.every(isValidContentBlock)))
        && (block.is_error === undefined || typeof block.is_error === 'boolean');
    default:
      return false;
  }
}

function isValidSource(value: unknown, types: string[], kind: 'image' | 'document'): boolean {
  if (!isRecord(value) || typeof value.type !== 'string' || !types.includes(value.type)) return false;
  const hasData = typeof value.data === 'string' && value.data.length > 0;
  const hasUrl = typeof value.url === 'string' && value.url.length > 0;
  const hasFileId = typeof value.file_id === 'string' && value.file_id.length > 0;
  if (!hasData && !hasUrl && !hasFileId) return false;
  if (kind === 'image' && value.type === 'url') return hasUrl;
  if (kind === 'image' && value.type === 'file') return hasFileId;
  if (kind === 'image' && value.type === 'base64') return hasData;
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
