/**
 * Integration test: a custom tool call is addressed by its **event** id.
 *
 * The published contract parks a custom tool call the same way it parks an
 * approval: the session emits `agent.custom_tool_use` (`会话事件流.md:1875`), pauses
 * with `stop_reason: requires_action` and the blocking event ids in
 * `stop_reason.event_ids` (`:1876`), and the client answers with
 * `user.custom_tool_result`, passing the event id in `custom_tool_use_id`
 * (`:1877`). So the id in circulation here is the event id, exactly as on the
 * approval path.
 *
 * The runtime reported nothing and accepted only the block id: the pending scan
 * covered `agent.tool_use` / `agent.mcp_tool_use` alone, so a session paused on a
 * custom tool call sent an **empty** `event_ids`, and a client that answered with
 * a real event id was refused with "custom_tool_use_id does not reference a
 * pending custom tool call".
 *
 * These assertions drive the real end-to-end exchange — a scripted model, the
 * real strategy, the real status transition — so the ids under test are the ones
 * the runtime actually published. They also pin that widening the address did not
 * move authority or corrupt the log: the block id still works, the stored
 * `metadata.custom_tool_use_id` stays the block id (the model-facing projection
 * pairs a custom tool result to its call by tool-call id), an answered call stops
 * being listed, and a second answer for one call is refused whichever spelling it
 * uses.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import type { LanguageModel } from 'ai';
import { Database } from '@/core/db/database.js';
import { ModelRegistry } from '@/model/registry.js';
import { LocalSandboxProvider } from '@/sandbox/local-provider.js';
import { DefaultSessionExecutor } from '@/core/session/executor.js';
import { SessionManager, type SessionExecutor } from '@/core/session/session-manager.js';
import { DefaultStrategy } from '@/strategy/default-strategy.js';
import type { EnvironmentConfig } from '@/types/sandbox.js';

const USAGE = { inputTokens: { total: 1 }, outputTokens: { total: 1 } };
const TOOL_CALLS = { unified: 'tool-calls', raw: 'tool_calls' } as const;
const STOP = { unified: 'stop', raw: 'stop' } as const;

/** One scripted model turn: custom tool calls to emit, or text to answer with. */
type Turn = { customCalls: Array<{ id: string; input: string }> } | { text: string };

/**
 * A model that replays a fixed script, one turn per `doStream`.
 *
 * The custom tool calls are emitted as real AI SDK tool-call parts, so the
 * strategy persists them through its own code path rather than the test writing
 * `agent.custom_tool_use` events it would then assert on.
 */
function scriptedModel(turns: Turn[]): LanguageModel {
  let turn = 0;
  return {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'scripted-custom-tool-event-id',
    supportedUrls: {},
    async doGenerate() {
      throw new Error('not used');
    },
    async doStream() {
      const script = turns[Math.min(turn, turns.length - 1)];
      turn += 1;
      return {
        stream: new ReadableStream({
          start(controller) {
            if ('customCalls' in script) {
              for (const call of script.customCalls) {
                controller.enqueue({ type: 'tool-input-start', id: call.id, toolName: 'lookup_customer' });
                controller.enqueue({ type: 'tool-input-delta', id: call.id, delta: call.input });
                controller.enqueue({ type: 'tool-input-end', id: call.id });
                controller.enqueue({
                  type: 'tool-call', toolCallId: call.id, toolName: 'lookup_customer', input: call.input,
                });
              }
              controller.enqueue({ type: 'finish', finishReason: TOOL_CALLS, usage: USAGE });
            } else {
              controller.enqueue({ type: 'text-start', id: 'text_1' });
              controller.enqueue({ type: 'text-delta', id: 'text_1', delta: script.text });
              controller.enqueue({ type: 'text-end', id: 'text_1' });
              controller.enqueue({ type: 'finish', finishReason: STOP, usage: USAGE });
            }
            controller.close();
          },
        }),
      } as any;
    },
  } as unknown as LanguageModel;
}

async function waitFor<T>(probe: () => T | undefined | null, what: string, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined && value !== null) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('Custom tool call addressed by event id', () => {
  let db: Database | undefined;
  let workspace: string | undefined;
  let manager: SessionManager | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
    manager = undefined;
    if (workspace) rmSync(workspace, { recursive: true, force: true });
    workspace = undefined;
  });

  async function setUp(turns: Turn[]) {
    workspace = mkdtempSync(join(process.env.TEMP ?? process.cwd(), 'ma-custom-event-id-'));
    db = new Database(join(workspace, 'test.db'));
    db.runMigrations();
    db.exec("INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')");
    db.exec("INSERT INTO agents (id, name, definition) VALUES ('agent_custom', 'custom-agent', '{}')");

    manager = new SessionManager(db);
    const registry = new ModelRegistry();
    registry.register({ name: 'scripted', provider: 'openai', model: 'scripted', is_default: true });
    const model = scriptedModel(turns);
    (registry as any).createModel = () => model;
    const provider = new LocalSandboxProvider(workspace);
    const executor = new DefaultSessionExecutor({
      agents: [{
        name: 'custom-agent',
        model: 'scripted',
        system: 'Use the customer lookup tool when needed.',
        tools: [{
          type: 'custom_toolset' as const,
          configs: [{
            name: 'lookup_customer',
            description: 'Look up a customer in the host application.',
            parameters: { type: 'object', properties: { customer_id: { type: 'string' } }, required: ['customer_id'] },
          }],
        }],
      }],
      modelRegistry: registry,
      sandboxProvider: provider,
      resolveEnvironmentConfig: () => ({ name: 'local', sandbox_provider: 'local' } as EnvironmentConfig),
      strategy: new DefaultStrategy(),
      eventLogger: manager.getEventLogger(),
    });
    manager.setExecutor(executor);
    return { manager, executor };
  }

  const oneCall: Turn[] = [
    { customCalls: [{ id: 'custom_call_1', input: JSON.stringify({ customer_id: 'cust_42' }) }] },
    { text: 'Customer lookup completed.' },
  ];

  /** The `stop_reason` object the runtime published on the last idle event. */
  function publishedStopReason(sessionId: string) {
    const idle = manager!.getEventLogger().getEvents(sessionId)
      .filter((e) => e.type === 'session.status_idle').at(-1);
    return idle?.metadata?.stop_reason as Record<string, unknown> | undefined;
  }

  function customUseEvent(sessionId: string, blockId: string) {
    return manager!.getEventLogger().getEvents(sessionId).find(
      (e) => e.type === 'agent.custom_tool_use'
        && (e.content?.[0] as any)?.id === blockId,
    );
  }

  function customResultEvents(sessionId: string) {
    return manager!.getEventLogger().getEvents(sessionId).filter((e) => e.type === 'user.custom_tool_result');
  }

  it('reports the pending custom tool call by its event id, not an empty array', async () => {
    const { manager: m, executor } = await setUp(oneCall);
    const session = m.create({ agent: 'agent_custom' });
    await m.sendEvent(session.id, {
      type: 'user.message', content: [{ type: 'text', text: 'Look up customer cust_42.' }],
    });
    await waitFor(() => (m.get(session.id)?.status === 'requires_action' ? true : undefined), 'requires_action');

    const useEvent = customUseEvent(session.id, 'custom_call_1');
    expect(useEvent).toBeDefined();

    const reason = publishedStopReason(session.id);
    expect(reason?.type).toBe('requires_action');
    // Before this change the array was empty here, because the scan only looked
    // at approval-gated tool calls.
    expect(reason?.event_ids).toEqual([useEvent!.id]);
    expect(reason?.event_ids).not.toContain('custom_call_1');
    expect(useEvent!.id).toMatch(/^sevt_/);
    await executor.cleanupSession(session.id);
  });

  it('accepts an answer naming the event id and resumes the model with the paired result', async () => {
    const { manager: m, executor } = await setUp(oneCall);
    const session = m.create({ agent: 'agent_custom' });
    await m.sendEvent(session.id, {
      type: 'user.message', content: [{ type: 'text', text: 'Look up customer cust_42.' }],
    });
    await waitFor(() => (m.get(session.id)?.status === 'requires_action' ? true : undefined), 'requires_action');
    const eventId = customUseEvent(session.id, 'custom_call_1')!.id;

    await m.sendEvent(session.id, {
      type: 'user.custom_tool_result',
      custom_tool_use_id: eventId,
      content: [{ type: 'text', text: '{"name":"Ada"}' }],
    });

    await waitFor(() => (m.get(session.id)?.status === 'paused' ? true : undefined), 'paused');
    const events = m.getEventLogger().getEvents(session.id);
    expect(events.some(
      (e) => e.type === 'agent.message' && JSON.stringify(e.content).includes('Customer lookup completed.'),
    )).toBe(true);
    await executor.cleanupSession(session.id);
  });

  it('still accepts an answer naming the block id', async () => {
    const { manager: m, executor } = await setUp(oneCall);
    const session = m.create({ agent: 'agent_custom' });
    await m.sendEvent(session.id, {
      type: 'user.message', content: [{ type: 'text', text: 'Look up customer cust_42.' }],
    });
    await waitFor(() => (m.get(session.id)?.status === 'requires_action' ? true : undefined), 'requires_action');

    await m.sendEvent(session.id, {
      type: 'user.custom_tool_result',
      custom_tool_use_id: 'custom_call_1',
      content: [{ type: 'text', text: '{"name":"Ada"}' }],
    });

    await waitFor(() => (m.get(session.id)?.status === 'paused' ? true : undefined), 'paused');
    expect(m.getEventLogger().getEvents(session.id).some(
      (e) => e.type === 'agent.message' && JSON.stringify(e.content).includes('Customer lookup completed.'),
    )).toBe(true);
    await executor.cleanupSession(session.id);
  });

  it('stores the block id in the result metadata, not the id the caller sent', async () => {
    const { manager: m, executor } = await setUp(oneCall);
    const session = m.create({ agent: 'agent_custom' });
    await m.sendEvent(session.id, {
      type: 'user.message', content: [{ type: 'text', text: 'Look up customer cust_42.' }],
    });
    await waitFor(() => (m.get(session.id)?.status === 'requires_action' ? true : undefined), 'requires_action');
    const eventId = customUseEvent(session.id, 'custom_call_1')!.id;

    await m.sendEvent(session.id, {
      type: 'user.custom_tool_result',
      custom_tool_use_id: eventId,
      content: [{ type: 'text', text: '{"name":"Ada"}' }],
    });

    // The model-facing projection pairs the custom tool result to its call by
    // tool-call id, so the persisted id has to be the block id even though an
    // event id was sent.
    await waitFor(() => (customResultEvents(session.id).length > 0 ? true : undefined), 'the result event');
    expect(customResultEvents(session.id)[0].metadata?.custom_tool_use_id).toBe('custom_call_1');
    await waitFor(() => (m.get(session.id)?.status === 'paused' ? true : undefined), 'paused');
    await executor.cleanupSession(session.id);
  });

  it('refuses a second answer for the same call even when it uses the other spelling', async () => {
    const { manager: m, executor } = await setUp(oneCall);
    const session = m.create({ agent: 'agent_custom' });
    await m.sendEvent(session.id, {
      type: 'user.message', content: [{ type: 'text', text: 'Look up customer cust_42.' }],
    });
    await waitFor(() => (m.get(session.id)?.status === 'requires_action' ? true : undefined), 'requires_action');
    const eventId = customUseEvent(session.id, 'custom_call_1')!.id;

    await m.sendEvent(session.id, {
      type: 'user.custom_tool_result',
      custom_tool_use_id: eventId,
      content: [{ type: 'text', text: '{"name":"Ada"}' }],
    });
    await waitFor(() => (customResultEvents(session.id).length > 0 ? true : undefined), 'the result event');

    // The other spelling must not be a way to answer the same call twice.
    await expect(m.sendEvent(session.id, {
      type: 'user.custom_tool_result',
      custom_tool_use_id: 'custom_call_1',
      content: [{ type: 'text', text: 'again' }],
    })).rejects.toThrow(/not pending/);
    await waitFor(() => (m.get(session.id)?.status === 'paused' ? true : undefined), 'paused');
    await executor.cleanupSession(session.id);
  });

  it('refuses an id that names neither the call nor a pending custom tool call', async () => {
    const { manager: m, executor } = await setUp(oneCall);
    const session = m.create({ agent: 'agent_custom' });
    await m.sendEvent(session.id, {
      type: 'user.message', content: [{ type: 'text', text: 'Look up customer cust_42.' }],
    });
    await waitFor(() => (m.get(session.id)?.status === 'requires_action' ? true : undefined), 'requires_action');

    await expect(m.sendEvent(session.id, {
      type: 'user.custom_tool_result',
      custom_tool_use_id: 'sevt_not_a_real_call',
      content: [{ type: 'text', text: 'x' }],
    })).rejects.toThrow(/does not reference a pending custom tool call/);
    await executor.cleanupSession(session.id);
  });

  it('stops listing a custom tool call once it has been answered', async () => {
    // Two calls are parked at once and only the first is answered, so the same
    // transition publishes `event_ids` twice and the two readings differ by
    // exactly one entry. The engine is stubbed here rather than scripted: this
    // asserts what the transition *publishes*, and driving a real second model
    // request would instead exercise a separate, pre-existing limitation —
    // resuming while another call is still parked fails the request with "Tool
    // result is missing for tool call ..." — which is not this change's behaviour
    // to pin. The status transition and the metadata computation under test are
    // the real ones.
    const { manager: m, executor: defaultExecutor } = await setUp(oneCall);
    void defaultExecutor;
    let turn = 0;
    const stub: SessionExecutor = {
      // eslint-disable-next-line require-yield
      async *execute(session, _event, options) {
        turn += 1;
        if (turn === 1) {
          for (const id of ['custom_call_1', 'custom_call_2']) {
            m.getEventLogger().append(session.id, {
              type: 'agent.custom_tool_use',
              content: [{ type: 'tool_use', id, name: 'lookup_customer', input: { customer_id: 'cust_42' } }],
              metadata: { custom_tool: true },
            });
          }
        }
        options?.onRequiresAction?.();
        return;
      },
    };
    m.setExecutor(stub);

    const session = m.create({ agent: 'agent_custom' });
    await m.sendEvent(session.id, { type: 'user.message', content: [{ type: 'text', text: 'go' }] });
    await waitFor(() => (customUseEvent(session.id, 'custom_call_2') ? true : undefined), 'both parked calls');

    const firstEventId = customUseEvent(session.id, 'custom_call_1')!.id;
    const secondEventId = customUseEvent(session.id, 'custom_call_2')!.id;
    await waitFor(
      () => (publishedStopReason(session.id)?.event_ids as string[] | undefined)?.length === 2 ? true : undefined,
      'both calls listed',
    );
    expect(publishedStopReason(session.id)?.event_ids).toEqual([firstEventId, secondEventId]);

    await m.sendEvent(session.id, {
      type: 'user.custom_tool_result',
      custom_tool_use_id: firstEventId,
      content: [{ type: 'text', text: '{"name":"Ada"}' }],
    });

    // The answer enqueues a turn, and that turn parks the session again, so the
    // array is republished from the log as it now stands.
    await waitFor(
      () => (publishedStopReason(session.id)?.event_ids as string[] | undefined)?.length === 1 ? true : undefined,
      'the republished event_ids',
    );
    const republished = publishedStopReason(session.id)?.event_ids as string[];
    // The answered call is gone; the still-unanswered one is kept.
    expect(republished).toEqual([secondEventId]);
    expect(republished).not.toContain(firstEventId);
  });

  it('carries exactly the published stop_reason shape, with no action_type', async () => {
    const { manager: m, executor } = await setUp(oneCall);
    const session = m.create({ agent: 'agent_custom' });
    await m.sendEvent(session.id, {
      type: 'user.message', content: [{ type: 'text', text: 'Look up customer cust_42.' }],
    });
    await waitFor(() => (m.get(session.id)?.status === 'requires_action' ? true : undefined), 'requires_action');

    // `action_type` was written here and declared in the protocol type, but it is
    // absent from the published contract, nothing read it, and with custom tool
    // calls in the array alongside approval-gated ones no single value is true.
    const reason = publishedStopReason(session.id);
    expect(reason).toBeDefined();
    expect(Object.keys(reason!).sort()).toEqual(['event_ids', 'type']);
    expect('action_type' in reason!).toBe(false);
    await executor.cleanupSession(session.id);
  });
});
