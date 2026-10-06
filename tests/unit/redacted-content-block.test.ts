/**
 * The `redacted` block is modelled in the `ContentBlock` union so runtime
 * output parses and serializes unchanged, while `redactedBlockProblem` gives
 * every user-facing ingress one shared refusal: a client that sends the block
 * is asking the log to claim the model withheld content it never produced.
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeMessageContent,
  redactedBlockProblem,
} from '@/api/routes/session-normalizers.js';
import type { ContentBlock } from '@/types/cma-protocol.js';

describe('redactedBlockProblem', () => {
  it('accepts ordinary content', () => {
    expect(redactedBlockProblem([{ type: 'text', text: 'hello' }])).toBeNull();
    expect(redactedBlockProblem('a bare string')).toBeNull();
    expect(redactedBlockProblem(undefined)).toBeNull();
    expect(redactedBlockProblem([])).toBeNull();
  });

  it('flags a top-level redacted block with its path', () => {
    const problem = redactedBlockProblem([
      { type: 'text', text: 'hi' },
      { type: 'redacted' },
    ]);
    expect(problem).toContain('content[1].type');
    expect(problem).toContain('redacted');
  });

  it('flags a redacted block nested inside tool_result content', () => {
    const problem = redactedBlockProblem([
      { type: 'tool_result', tool_use_id: 'toolu_x', content: [{ type: 'redacted' }] },
    ]);
    expect(problem).toContain('content[0].content[0]');
  });

  it('honours the caller-chosen field name', () => {
    const problem = redactedBlockProblem([{ type: 'redacted' }], 'input');
    expect(problem).toContain('input[0].type');
  });
});

describe('normalizeMessageContent tolerance', () => {
  it('parses a redacted block as a ContentBlock so ingress can report it', () => {
    const blocks = normalizeMessageContent([{ type: 'redacted' }]);
    expect(blocks).toEqual([{ type: 'redacted' }]);
    const redacted: ContentBlock | undefined = blocks?.[0];
    expect(redacted?.type).toBe('redacted');
  });
});
