/**
 * `system.message` event domain.
 *
 * The published contract defines `system.message` as privileged system-level
 * context that applies to the accompanying turn *and every later turn*, in
 * contrast to the agent's `system` field which sets the top-level prompt. Two
 * things therefore have to hold locally:
 *
 * - the block is projected as its own `system` role turn, not merged into the
 *   agent's system prompt (replacing the prompt would be a different feature);
 * - it stays in context for later turns, which is what distinguishes it from a
 *   one-shot instruction.
 *
 * The 1–1000 text-item bound is also enforced, because a rejected batch has to
 * fail before it reaches the append-only log.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_SYSTEM_MESSAGE_BLOCKS,
  normalizeSystemMessageContent,
  systemMessageContentError,
} from '@/api/routes/system-message.js';
import { eventsToMessages } from '@/core/session/events-to-messages.js';
import type { SessionEvent } from '@/types/session.js';
import type { CMAEventType, ContentBlock } from '@/types/cma-protocol.js';

let seq = 0;
function ev(type: CMAEventType, content?: ContentBlock[]): SessionEvent {
  return { id: `sevt_${++seq}`, sessionId: 'sess_1', seq, type, content, createdAt: new Date() };
}

describe('normalizeSystemMessageContent', () => {
  it('accepts a non-empty array of text blocks', () => {
    const content = normalizeSystemMessageContent([{ type: 'text', text: 'Use the demo policy.' }]);
    expect(content).toEqual([{ type: 'text', text: 'Use the demo policy.' }]);
  });

  it('rejects an empty array', () => {
    expect(normalizeSystemMessageContent([])).toBeNull();
  });

  it('rejects a bare string — content must be block-shaped', () => {
    // Unlike user.message, the contract documents content as 1–1000 *text
    // items*, so a shorthand string is not accepted here.
    expect(normalizeSystemMessageContent('hello')).toBeNull();
  });

  it('rejects a block with empty text', () => {
    expect(normalizeSystemMessageContent([{ type: 'text', text: '   ' }])).toBeNull();
  });

  it('accepts exactly the published maximum of blocks', () => {
    const blocks = Array.from({ length: MAX_SYSTEM_MESSAGE_BLOCKS }, (_, i) => ({
      type: 'text' as const,
      text: `line ${i}`,
    }));
    expect(normalizeSystemMessageContent(blocks)).toHaveLength(MAX_SYSTEM_MESSAGE_BLOCKS);
  });

  it('rejects one block beyond the published maximum', () => {
    const blocks = Array.from({ length: MAX_SYSTEM_MESSAGE_BLOCKS + 1 }, (_, i) => ({
      type: 'text' as const,
      text: `line ${i}`,
    }));
    expect(normalizeSystemMessageContent(blocks)).toBeNull();
  });
});

describe('systemMessageContentError', () => {
  it('says nothing when the payload is valid', () => {
    expect(systemMessageContentError([{ type: 'text', text: 'ok' }])).toBeUndefined();
  });

  it('names the size limit, not a generic shape error, when too many blocks are sent', () => {
    const tooMany = Array.from({ length: MAX_SYSTEM_MESSAGE_BLOCKS + 5 }, () => ({ type: 'text', text: 'x' }));
    const message = systemMessageContentError(tooMany);
    expect(message).toContain(String(MAX_SYSTEM_MESSAGE_BLOCKS));
    expect(message).toContain(String(MAX_SYSTEM_MESSAGE_BLOCKS + 5));
  });

  it('falls back to the shape error for a malformed payload', () => {
    expect(systemMessageContentError([])).toContain('non-empty array');
    expect(systemMessageContentError('nope')).toContain('non-empty array');
  });
});

describe('eventsToMessages — system.message projection', () => {
  it('projects as a system role turn rather than folding into the prompt', () => {
    const messages = eventsToMessages([
      ev('user.message', [{ type: 'text', text: 'start' }]),
      ev('system.message', [{ type: 'text', text: 'Follow the demo policy.' }]),
    ]);

    const system = messages.filter((message) => message.role === 'system');
    expect(system).toHaveLength(1);
    expect(system[0].content).toContain('Follow the demo policy.');
  });

  it('remains in context for every later turn', () => {
    const messages = eventsToMessages([
      ev('user.message', [{ type: 'text', text: 'first' }]),
      ev('agent.message', [{ type: 'text', text: 'ack' }]),
      ev('system.message', [{ type: 'text', text: 'Revised constraint.' }]),
      ev('user.message', [{ type: 'text', text: 'second' }]),
      ev('agent.message', [{ type: 'text', text: 'done' }]),
    ]);

    // Sent mid-conversation, still present at the end of the projected history.
    expect(messages.some((m) => m.role === 'system' && m.content.includes('Revised constraint.'))).toBe(true);
    // And the turns on both sides of it survived.
    expect(messages.filter((m) => m.role === 'user')).toHaveLength(2);
  });

  it('does not let a system.message swallow a pending assistant turn', () => {
    const messages = eventsToMessages([
      ev('user.message', [{ type: 'text', text: 'q' }]),
      ev('agent.message', [{ type: 'text', text: 'partial answer' }]),
      ev('system.message', [{ type: 'text', text: 'New rule.' }]),
    ]);

    // The assistant text must still be its own turn, not absorbed into system.
    const assistant = messages.find((m) => m.role === 'assistant');
    expect(assistant).toBeDefined();
    expect(JSON.stringify(assistant)).toContain('partial answer');
  });

  it('drops a system.message with no usable text instead of emitting an empty turn', () => {
    const messages = eventsToMessages([
      ev('user.message', [{ type: 'text', text: 'q' }]),
      ev('system.message', [{ type: 'text', text: '   ' }]),
    ]);
    expect(messages.filter((m) => m.role === 'system')).toHaveLength(0);
  });
});
