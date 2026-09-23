import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { PiStrategy } from '@/strategy/pi-strategy.js';
import type { SessionEvent } from '@/types/session.js';
import type { StrategyContext, EventLogWriter } from '@/types/strategy.js';

function contextFor(events: SessionEvent[], broadcasts: SessionEvent[], usage: number[][]): StrategyContext {
  let sequence = 0;
  return {
    session: {
      id: 'sess_pi_adapter',
      loopEngine: 'pi',
      agentId: 'agent_pi',
      agentName: 'pi-agent',
      environmentId: 'env_default',
      status: 'running',
      createdAt: new Date(),
      updatedAt: new Date(),
      // The session freezes its own definition, and the launch compiles its tool
      // flags from it. The executor resolves the definition (or raises "Agent not
      // found") before a strategy runs, so a context without one is not a state
      // the runtime can reach.
      agentDefinition: {
        name: 'pi-agent',
        model: 'fixture-model',
        system: 'system',
        tools: [{ type: 'agent_toolset_20260401', configs: [{ name: 'read' }] }],
      },
    },
    userEvent: { type: 'user.message', content: [{ type: 'text', text: 'hello' }] },
    systemPrompt: 'system',
    messages: [],
    modelConfig: { name: 'fixture', provider: 'openai', model: 'fixture-model', api_key: 'fixture-key' },
    tools: {},
    sandbox: { sessionId: 'sess_pi_adapter', hostWorkDir: 'C:/workspace' },
    eventLog: {
      append(_sessionId: string, event: Parameters<EventLogWriter['append']>[1]) {
        const persisted = {
          id: `sevt_${++sequence}`,
          sessionId: 'sess_pi_adapter',
          seq: sequence,
          type: event.type,
          content: event.content,
          modelUsed: event.modelUsed,
          tokensIn: event.tokensIn,
          tokensOut: event.tokensOut,
          stopReason: event.stopReason,
          durationMs: event.durationMs,
          parentEventId: event.parentEventId,
          createdAt: new Date(),
          processedAt: new Date(),
        } as SessionEvent;
        events.push(persisted);
        return persisted;
      },
      getLatestSeq: () => sequence,
      recordUsage: (_sessionId: string, input: number, output: number) => usage.push([input, output]),
    },
    broadcast: (event: SessionEvent) => broadcasts.push(event),
    config: {},
  } as unknown as StrategyContext;
}

describe('PiStrategy stdout adapter', () => {
  it('persists before broadcasting and does not yield duplicate durable events', async () => {
    const events: SessionEvent[] = [];
    const broadcasts: SessionEvent[] = [];
    const usage: number[][] = [];
    let terminateCalls = 0;
    const strategy = new PiStrategy({
      async launch() {},
      async start() {
        return {
          child: {} as any,
          stdout: Readable.from([
            '{"type":"session","id":"fixture"}\n',
            '{"type":"turn_start"}\n',
            '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"reply"}}\n',
            '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"reply"}],"usage":{"input":2,"output":1}}}\n',
            '{"type":"turn_end","message":{"role":"assistant","usage":{"input":2,"output":1},"stopReason":"stop"}}\n',
          ]),
          stderr: Readable.from(['authorization: Bearer secret-value\n']),
          wait: async () => ({ code: 0, signal: null }),
          terminate: async () => { terminateCalls += 1; },
        };
      },
    });
    const context = contextFor(events, broadcasts, usage);

    const yielded: SessionEvent[] = [];
    for await (const event of strategy.execute(context)) yielded.push(event);

    expect(yielded).toEqual([]);
    expect(events.map((event) => event.type)).toEqual([
      'span.model_request_start',
      'agent.message',
      'span.model_request_end',
      'turn_complete',
    ]);
    expect(broadcasts.filter((event) => event.seq > 0).map((event) => event.id)).toEqual(events.map((event) => event.id));
    expect(broadcasts.filter((event) => event.seq === 0).map((event) => event.type)).toEqual([
      'agent.message_stream_start', 'agent.message_chunk', 'agent.message_stream_end',
    ]);
    expect(usage).toEqual([[2, 1]]);
    expect(terminateCalls).toBe(0);
  });
});
