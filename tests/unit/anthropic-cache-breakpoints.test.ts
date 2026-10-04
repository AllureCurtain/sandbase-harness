/**
 * Unit tests for `applyAnthropicCacheBreakpoints` — the fixed breakpoint
 * placement WP4 D1 pins down: system prompt, last tool definition, and the
 * second-to-last message, all `{type: 'ephemeral'}` at the default TTL.
 */

import { describe, expect, it } from 'vitest';
import { applyAnthropicCacheBreakpoints } from '@/strategy/anthropic-cache-breakpoints.js';

const CACHE_CONTROL = { type: 'ephemeral' };

function cacheControls(value: unknown): unknown[] {
  const found: unknown[] = [];
  JSON.parse(JSON.stringify(value ?? null), (key, entry) => {
    if (key === 'cacheControl') found.push(entry);
    return entry;
  });
  return found;
}

describe('applyAnthropicCacheBreakpoints', () => {
  it('marks the system prompt, the last tool, and the second-to-last message', () => {
    const messages: Array<{ role: string; content: string; providerOptions?: Record<string, any> }> = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'next' },
    ];
    const tools = {
      glob: { description: 'glob', inputSchema: {} },
      read: { description: 'read', inputSchema: {} },
    };

    const shaped = applyAnthropicCacheBreakpoints({ systemPrompt: 'sys', messages, tools });

    const system = shaped.system as { role: string; providerOptions?: Record<string, any> };
    expect(system.role).toBe('system');
    expect(system.providerOptions?.anthropic?.cacheControl).toEqual(CACHE_CONTROL);

    // Only the second-to-last message carries the marker — the last message
    // is the input that changed.
    expect(messages[1]).not.toHaveProperty('providerOptions');
    expect(shaped.messages[1].providerOptions?.anthropic?.cacheControl).toEqual(CACHE_CONTROL);
    expect(shaped.messages[0]).not.toHaveProperty('providerOptions');
    expect(shaped.messages[2]).not.toHaveProperty('providerOptions');

    // Only the last tool by insertion order.
    expect((shaped.tools!.read as any).providerOptions?.anthropic?.cacheControl).toEqual(CACHE_CONTROL);
    expect((shaped.tools!.glob as any).providerOptions).toBeUndefined();
  });

  it('drops the message breakpoint when fewer than two messages exist', () => {
    const shaped = applyAnthropicCacheBreakpoints({
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'only' }],
      tools: { glob: { description: 'g' } },
    });
    expect(shaped.messages[0]).not.toHaveProperty('providerOptions');
    expect(cacheControls(shaped)).toHaveLength(2);
  });

  it('omits the tool breakpoint when there are no tools', () => {
    const shaped = applyAnthropicCacheBreakpoints({
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }],
      tools: undefined,
    });
    expect(shaped.tools).toBeUndefined();
    expect(cacheControls(shaped)).toHaveLength(2);
  });

  it('omits the system breakpoint when there is no system prompt', () => {
    const shaped = applyAnthropicCacheBreakpoints({
      systemPrompt: undefined,
      messages: [{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }],
    });
    expect(shaped.system).toBeUndefined();
  });

  it('merges into providerOptions the message already carries', () => {
    const messages: Array<{ role: string; content: string; providerOptions?: Record<string, any> }> = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b', providerOptions: { anthropic: { thinking: 'x' }, other: { keep: 1 } } },
      { role: 'user', content: 'c' },
    ];
    const shaped = applyAnthropicCacheBreakpoints({ messages });
    const options = shaped.messages[1].providerOptions as Record<string, any>;
    expect(options.anthropic.cacheControl).toEqual(CACHE_CONTROL);
    expect(options.anthropic.thinking).toBe('x');
    expect(options.other.keep).toBe(1);
  });

  it('does not mutate the caller’s messages or tools', () => {
    const messages = [{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }];
    const tools = { read: { description: 'r' } };
    applyAnthropicCacheBreakpoints({ systemPrompt: 'sys', messages, tools });
    expect(messages.every((message) => !('providerOptions' in message))).toBe(true);
    expect(tools.read).not.toHaveProperty('providerOptions');
  });
});
