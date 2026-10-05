/**
 * In-loop context guard: the per-turn compactor only runs between turns, so
 * a long tool loop must trim stale tool outputs from the outgoing request or
 * the provider rejects it mid-turn. These cover the estimator and the
 * trimmer's ordering, tail retention, and non-mutation guarantees.
 */

import { describe, expect, it } from 'vitest';
import type { ModelMessage } from 'ai';
import {
  IN_LOOP_TRIM_PLACEHOLDER,
  estimateModelMessagesTokens,
  trimInFlightToolResults,
} from '@/strategy/in-loop-context.js';

function toolResultMessage(callId: string, value: string): ModelMessage {
  return {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: callId, toolName: 'bash', output: { type: 'text', value } }],
  } as unknown as ModelMessage;
}

function toolOutputOf(message: ModelMessage): string {
  const part = (message as { content: Array<{ output: { value: string } }> }).content[0];
  return part.output.value;
}

describe('in-loop context guard', () => {
  it('estimates message content at roughly four characters per token', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'a'.repeat(400) }] } as unknown as ModelMessage,
      toolResultMessage('c1', 'b'.repeat(800)),
    ];
    expect(estimateModelMessagesTokens(messages)).toBe(300);
  });

  it('returns null when the estimate already fits the target', () => {
    const messages = [toolResultMessage('c1', 'small')];
    expect(trimInFlightToolResults(messages, 10_000)).toBeNull();
  });

  it('trims oldest tool results first and keeps the recent tail verbatim', () => {
    const big = 'x'.repeat(4_000); // ~1,000 tokens each
    const messages: ModelMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] } as unknown as ModelMessage,
      ...[1, 2, 3, 4, 5].map((n) => toolResultMessage(`c${n}`, big)),
    ];
    // ~5,005 estimated tokens; target forces the two oldest results out while
    // the newest three stay readable.
    const trimmed = trimInFlightToolResults(messages, 3_200)!;
    expect(trimmed).not.toBeNull();
    expect(toolOutputOf(trimmed[1])).toBe(IN_LOOP_TRIM_PLACEHOLDER);
    expect(toolOutputOf(trimmed[2])).toBe(IN_LOOP_TRIM_PLACEHOLDER);
    expect(toolOutputOf(trimmed[3])).toBe(big);
    expect(toolOutputOf(trimmed[5])).toBe(big);
    // The caller's messages are never mutated.
    expect(toolOutputOf(messages[1])).toBe(big);
  });

  it('trims even the recent tail when it alone exceeds the target', () => {
    const big = 'x'.repeat(8_000); // ~2,000 tokens
    const messages: ModelMessage[] = [
      toolResultMessage('c1', big),
      toolResultMessage('c2', 'small'),
    ];
    const trimmed = trimInFlightToolResults(messages, 100)!;
    expect(toolOutputOf(trimmed[0])).toBe(IN_LOOP_TRIM_PLACEHOLDER);
    // The second result is trimmed only while the request is still over —
    // once c1 collapses it fits, so the small recent result stays.
    expect(toolOutputOf(trimmed[1])).toBe('small');
  });

  it('trims the recent tail too when every result is oversized', () => {
    const big = 'x'.repeat(8_000);
    const messages = [toolResultMessage('c1', big), toolResultMessage('c2', big)];
    const trimmed = trimInFlightToolResults(messages, 100)!;
    expect(toolOutputOf(trimmed[0])).toBe(IN_LOOP_TRIM_PLACEHOLDER);
    expect(toolOutputOf(trimmed[1])).toBe(IN_LOOP_TRIM_PLACEHOLDER);
  });
});
