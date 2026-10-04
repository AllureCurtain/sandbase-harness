/**
 * Unit tests for the Context Compactor (R9.15, Property 11).
 */

import { describe, it, expect } from 'vitest';
import {
  ContextCompactor,
  estimateMessagesTokens,
} from '@/core/session/context-compactor.js';
import type { Message } from '@/core/session/events-to-messages.js';
import type { SessionEvent } from '@/types/session.js';
import type { CMAEventType, ContentBlock } from '@/types/cma-protocol.js';
import type { LanguageModel } from 'ai';

let seq = 0;
function ev(type: CMAEventType, content?: ContentBlock[]): SessionEvent {
  return {
    id: `sevt_${++seq}`,
    sessionId: 'sess_1',
    seq,
    type,
    content,
    createdAt: new Date(),
  };
}

function userMsg(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] };
}

/** A fake model that returns a fixed summary via generateText. */
function fakeModel(summaryText: string, onGenerate?: (req: any) => void): LanguageModel {
  return {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'test-model',
    supportedUrls: {},
    async doGenerate(req: any) {
      onGenerate?.(req);
      return {
        content: [{ type: 'text', text: summaryText }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } },
        warnings: [],
      } as any;
    },
    async doStream() {
      throw new Error('not used');
    },
  } as unknown as LanguageModel;
}

function toolUse(id: string, name = 'bash'): SessionEvent {
  return ev('agent.tool_use', [
    { type: 'tool_use', id, name, input: { cmd: 'ls' } } as any,
  ]);
}

function toolResult(id: string): SessionEvent {
  return ev('agent.tool_result', [
    { type: 'tool_result', tool_use_id: id, content: 'ok' } as any,
  ]);
}

describe('ContextCompactor', () => {
  describe('shouldCompact', () => {
    it('does not trigger for small histories', () => {
      const c = new ContextCompactor({ contextWindowTokens: 1000, triggerFraction: 0.8 });
      const msgs = [userMsg('short')];
      expect(c.shouldCompact(msgs)).toBe(false);
    });

    it('triggers when estimated tokens exceed the threshold', () => {
      const c = new ContextCompactor({ contextWindowTokens: 100, triggerFraction: 0.8 });
      const big = 'x'.repeat(400);
      const msgs = [userMsg(big), userMsg(big)];
      expect(c.shouldCompact(msgs)).toBe(true);
    });

    it('respects an explicit context window arg', () => {
      const c = new ContextCompactor();
      const big = 'x'.repeat(4000); // ~1000 tokens
      expect(c.shouldCompact([userMsg(big)], 500)).toBe(true);
      expect(c.shouldCompact([userMsg(big)], 1_000_000)).toBe(false);
    });
  });

  describe('splitAtomicGroups', () => {
    it('starts a new group at user turns and keeps tool pairs together', () => {
      const events = [
        ev('user.message', [{ type: 'text', text: 'q1' }]),
        ev('agent.message', [{ type: 'text', text: 'a1' }]),
        ev('user.message', [{ type: 'text', text: 'q2' }]),
        toolUse('t1'),
        ev('user.tool_confirmation'),
        toolResult('t1'),
        ev('agent.message', [{ type: 'text', text: 'a2' }]),
      ];
      const groups = new ContextCompactor().splitAtomicGroups(events);
      expect(groups).toHaveLength(2);
      expect(groups[1].events.map((e) => e.type)).toEqual([
        'user.message',
        'agent.tool_use',
        'user.tool_confirmation',
        'agent.tool_result',
        'agent.message',
      ]);
    });

    it('keeps a tool call and a non-adjacent result in one group', () => {
      const events = [
        ev('user.message', [{ type: 'text', text: 'q' }]),
        toolUse('t1'),
        ev('agent.thinking', [{ type: 'text', text: 'hmm' }]),
        ev('session.status_running'),
        toolResult('t1'),
      ];
      const groups = new ContextCompactor().splitAtomicGroups(events);
      expect(groups).toHaveLength(1);
      expect(groups[0].events).toHaveLength(5);
    });

    it('opens leading non-user events as their own group', () => {
      const events = [
        ev('session.status_running'),
        ev('user.message', [{ type: 'text', text: 'q' }]),
      ];
      const groups = new ContextCompactor().splitAtomicGroups(events);
      expect(groups).toHaveLength(2);
    });
  });

  describe('compact', () => {
    it('returns null when there is a single group', async () => {
      const c = new ContextCompactor();
      const events = [
        ev('user.message', [{ type: 'text', text: 'q' }]),
        ev('agent.message', [{ type: 'text', text: 'a' }]),
      ];
      expect(await c.compact(events, null, fakeModel('s'))).toBeNull();
    });

    it('returns null when everything fits inside the preserve budget', async () => {
      const c = new ContextCompactor({ contextWindowTokens: 400, preserveBudgetTokens: 10_000 });
      const events = [
        ev('user.message', [{ type: 'text', text: 'q1' }]),
        ev('agent.message', [{ type: 'text', text: 'a1' }]),
        ev('user.message', [{ type: 'text', text: 'q2' }]),
      ];
      expect(await c.compact(events, null, fakeModel('s'))).toBeNull();
    });

    it('summarizes groups before the token-budgeted tail', async () => {
      // Budget admits only the last group.
      const c = new ContextCompactor({ contextWindowTokens: 10_000, preserveBudgetTokens: 15 });
      const events = [
        ev('user.message', [{ type: 'text', text: 'old question ' + 'x'.repeat(200) }]),
        ev('agent.message', [{ type: 'text', text: 'old answer ' + 'x'.repeat(200) }]),
        ev('user.message', [{ type: 'text', text: 'middle ' + 'x'.repeat(80) }]),
        ev('agent.message', [{ type: 'text', text: 'middle answer' }]),
        ev('user.message', [{ type: 'text', text: 'latest' }]),
        ev('agent.message', [{ type: 'text', text: 'latest answer' }]),
      ];
      const result = await c.compact(events, null, fakeModel('this is the summary'));
      expect(result).not.toBeNull();
      expect(result!.summary).toBe('this is the summary');
      // Events with seq <= eventSeqBefore are summarized; the rest is preserved.
      const preserved = events.filter((e) => e.seq > result!.eventSeqBefore);
      expect(preserved.map((e) => (e.content?.[0] as any).text)).toEqual([
        'latest',
        'latest answer',
      ]);
      expect(result!.preservedGroupCount).toBe(1);
    });

    it('keeps at least one group even when it exceeds the budget', async () => {
      const c = new ContextCompactor({ contextWindowTokens: 10_000, preserveBudgetTokens: 1 });
      const events = [
        ev('user.message', [{ type: 'text', text: 'first' }]),
        ev('user.message', [{ type: 'text', text: 'second ' + 'x'.repeat(100) }]),
      ];
      const result = await c.compact(events, null, fakeModel('s'));
      expect(result).not.toBeNull();
      expect(result!.preservedGroupCount).toBe(1);
    });

    it('returns null when the last group alone overflows the window', async () => {
      const c = new ContextCompactor({ contextWindowTokens: 10 });
      const events = [
        ev('user.message', [{ type: 'text', text: 'small' }]),
        ev('user.message', [{ type: 'text', text: 'y'.repeat(4000) }]),
      ];
      expect(await c.compact(events, null, fakeModel('s'))).toBeNull();
    });

    it('folds the prior summary into the next one and scopes by boundary', async () => {
      let seenPrompt = '';
      const model = fakeModel('new summary', (req) => {
        seenPrompt = JSON.stringify(req.prompt ?? req.messages ?? '');
      });

      const old = [
        ev('user.message', [{ type: 'text', text: 'ancient' }]),
        ev('agent.message', [{ type: 'text', text: 'ancient reply' }]),
      ];
      const recent = [
        ev('user.message', [{ type: 'text', text: 'middle ' + 'x'.repeat(200) }]),
        ev('agent.message', [{ type: 'text', text: 'mid ' + 'x'.repeat(200) }]),
        ev('user.message', [{ type: 'text', text: 'fresh' }]),
        ev('agent.message', [{ type: 'text', text: 'fresh reply' }]),
      ];
      const events = [...old, ...recent];
      const prior = { summary: 'PRIOR SUMMARY', eventSeqBefore: old[1].seq };
      const c = new ContextCompactor({ contextWindowTokens: 10_000, preserveBudgetTokens: 60 });
      const result = await c.compact(events, prior, model);
      expect(result).not.toBeNull();
      // Only post-boundary events can be covered by the new boundary.
      expect(result!.eventSeqBefore).toBeGreaterThan(prior.eventSeqBefore);
      expect(seenPrompt).toContain('PRIOR SUMMARY');
      expect(seenPrompt).not.toContain('ancient reply');
    });
  });

  describe('estimateMessagesTokens', () => {
    it('is roughly chars/4', () => {
      const msg = userMsg('x'.repeat(400));
      expect(estimateMessagesTokens([msg])).toBeGreaterThanOrEqual(100);
    });
  });
});
