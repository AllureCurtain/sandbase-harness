/**
 * Integration test: a resume turn starts only when no call is still parked.
 *
 * The published client answers **every** entry of `stop_reason.event_ids` in
 * turn: `会话事件流.md:1908` iterates the array straight back into
 * `user.tool_confirmation` (`:1929` and `:1955`-`:1957` do the same in Python and
 * JavaScript), and `权限策略.md:669` says to send one answer per blocking event. A
 * step that emits two tool calls parks two, so a partial answer is the normal
 * case, not an edge case.
 *
 * The resume gate used to consider only the confirmation group of the call being
 * answered, so any custom tool call parked at the same time was invisible to it
 * and the turn started against an incomplete tool-result sequence. The provider
 * refused the request with `Tool result is missing for tool call <id>` and the
 * session was **terminated** for what was a documented, well-formed answer.
 * Measured on the merge before this change, driving the real strategy and the
 * real status transition:
 *
 * | Parked | Answered | Result |
 * | --- | --- | --- |
 * | two custom calls | the first | `failed`, `Tool result is missing for tool call custom_call_2` |
 * | gated + custom | the custom one | `failed`, `Tool result is missing for tool call call_gated` |
 * | gated + custom | the gated one | `failed`, `Tool result is missing for tool call custom_call_1` |
 * | two gated calls in one confirmation group | the first | correct — stayed `requires_action` |
 *
 * So the gate worked for the one shape it was written for and failed the three it
 * did not cover. These assertions pin all four, in both directions: while a call
 * is parked no turn may run, and when the last one is answered the turn runs with
 * every call paired. They also pin that the gate and `stop_reason.event_ids` are
 * one definition: the array is read from the same real transition the gate reads.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import type { LanguageModel } from 'ai';
import { Database } from '@/core/db/database.js';
import { ModelRegistry } from '@/model/registry.js';
import { LocalSandboxProvider } from '@/sandbox/local-provider.js';
import { DefaultSessionExecutor } from '@/core/session/executor.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { DefaultStrategy } from '@/strategy/default-strategy.js';
import type { EnvironmentConfig } from '@/types/sandbox.js';

const USAGE = { inputTokens: { total: 1 }, outputTokens: { total: 1 } };
const TOOL_CALLS = { unified: 'tool-calls', raw: 'tool_calls' } as const;
const STOP = { unified: 'stop', raw: 'stop' } as const;

interface ScriptedCall { id: string; name: string }

/** Each parked call's arguments must satisfy its own tool's schema. */
function inputFor(name: string): string {
  return name === 'bash'
    ? JSON.stringify({ command: 'echo probe' })
    : JSON.stringify({ customer_id: 'cust_42' });
}

/**
 * A model that emits `calls` on the first turn and a fixed text answer on every
 * turn after it.
 *
 * One instance drives every turn: a fresh instance per `createModel` call would
 * reset the turn counter and re-emit the tool calls forever.
 */
function scriptedModel(calls: ScriptedCall[], answer: string): LanguageModel {
  let turn = 0;
  return {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'scripted-resume-gate',
    supportedUrls: {},
    async doGenerate() { throw new Error('not used'); },
    async doStream() {
      const first = turn === 0;
      turn += 1;
      return {
        stream: new ReadableStream({
          start(controller) {
            if (first) {
              for (const call of calls) {
                const input = inputFor(call.name);
                controller.enqueue({ type: 'tool-input-start', id: call.id, toolName: call.name });
                controller.enqueue({ type: 'tool-input-delta', id: call.id, delta: input });
                controller.enqueue({ type: 'tool-input-end', id: call.id });
                controller.enqueue({ type: 'tool-call', toolCallId: call.id, toolName: call.name, input });
              }
              controller.enqueue({ type: 'finish', finishReason: TOOL_CALLS, usage: USAGE });
            } else {
              controller.enqueue({ type: 'text-start', id: 'text_1' });
              controller.enqueue({ type: 'text-delta', id: 'text_1', delta: answer });
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

async function waitFor(probe: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (probe()) return;
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Let any turn that is going to start actually start, so "no turn" is meaningful. */
const SETTLE_MS = 1500;

describe('Resume gate — a turn starts only when nothing is parked', () => {
  let db: Database | undefined;
  let workspace: string | undefined;
  let manager: SessionManager | undefined;
  let executor: DefaultSessionExecutor | undefined;
  let sessionId: string | undefined;

  afterEach(async () => {
    if (executor && sessionId) await executor.cleanupSession(sessionId).catch(() => {});
    db?.close();
    db = undefined;
    manager = undefined;
    executor = undefined;
    sessionId = undefined;
    if (workspace) rmSync(workspace, { recursive: true, force: true });
    workspace = undefined;
  });

  async function setUp(calls: ScriptedCall[], answer: string) {
    workspace = mkdtempSync(join(process.env.TEMP ?? process.cwd(), 'ma-resume-gate-'));
    db = new Database(join(workspace, 'test.db'));
    db.runMigrations();
    db.exec("INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')");
    db.exec("INSERT INTO agents (id, name, definition) VALUES ('agent_mix', 'mix-agent', '{}')");

    manager = new SessionManager(db);
    const registry = new ModelRegistry();
    registry.register({ name: 'scripted', provider: 'openai', model: 'scripted', is_default: true });
    const model = scriptedModel(calls, 'resumed');
    (registry as any).createModel = () => model;
    executor = new DefaultSessionExecutor({
      agents: [{
        name: 'mix-agent', model: 'scripted', system: 'x',
        tools: [
          { type: 'agent_toolset_20260401' as const,
            default_config: { enabled: true, permission_policy: { type: 'always_allow' } },
            configs: [{ name: 'bash', enabled: true, permission_policy: { type: 'always_ask' } }] },
          { type: 'custom_toolset' as const,
            configs: [{ name: 'lookup_customer', description: 'd',
              parameters: { type: 'object', properties: { customer_id: { type: 'string' } }, required: ['customer_id'] } }] },
        ],
      }],
      modelRegistry: registry,
      sandboxProvider: new LocalSandboxProvider(workspace),
      resolveEnvironmentConfig: () => ({ name: 'local', sandbox_provider: 'local' } as EnvironmentConfig),
      strategy: new DefaultStrategy(),
      eventLogger: manager.getEventLogger(),
    });
    manager.setExecutor(executor);

    const session = manager.create({ agent: 'agent_mix' });
    sessionId = session.id;
    await manager.sendEvent(session.id, {
      type: 'user.message', content: [{ type: 'text', text: 'go' }],
    });
    await waitFor(() => manager!.get(session.id)?.status === 'requires_action', 'requires_action');
    return session.id;
  }

  function events(sessionId: string) {
    return manager!.getEventLogger().getEvents(sessionId);
  }

  /** The `stop_reason` the runtime last published, from the real transition. */
  function publishedEventIds(sessionId: string): string[] {
    const idle = events(sessionId).filter((e) => e.type === 'session.status_idle').at(-1);
    return ((idle?.metadata?.stop_reason as { event_ids?: string[] } | undefined)?.event_ids) ?? [];
  }

  function eventIdOf(sessionId: string, blockId: string): string {
    const found = events(sessionId).find(
      (e) => (e.type === 'agent.tool_use' || e.type === 'agent.custom_tool_use'
        || e.type === 'agent.mcp_tool_use')
        && (e.content?.[0] as any)?.id === blockId,
    );
    if (!found) throw new Error(`no parked event for block id ${blockId}`);
    return found.id;
  }

  async function answerCustom(sessionId: string, blockId: string) {
    await manager!.sendEvent(sessionId, {
      type: 'user.custom_tool_result',
      custom_tool_use_id: eventIdOf(sessionId, blockId),
      content: [{ type: 'text', text: '{"name":"Ada"}' }],
    } as any);
    await new Promise((r) => setTimeout(r, SETTLE_MS));
  }

  async function answerGated(sessionId: string, blockId: string) {
    await manager!.sendEvent(sessionId, {
      type: 'user.tool_confirmation',
      tool_use_id: eventIdOf(sessionId, blockId),
      result: 'allow',
    } as any);
    await new Promise((r) => setTimeout(r, SETTLE_MS));
  }

  /** A turn ran iff the scripted model's second-turn text reached the log. */
  function resumed(sessionId: string) {
    return events(sessionId).some(
      (e) => e.type === 'agent.message' && JSON.stringify(e.content).includes('resumed'),
    );
  }

  function sessionError(sessionId: string) {
    return events(sessionId).find((e) => e.type === 'session.error');
  }

  function assertHeldWithoutFailure(sessionId: string) {
    expect(manager!.get(sessionId)?.status).toBe('requires_action');
    expect(sessionError(sessionId)).toBeUndefined();
    expect(resumed(sessionId)).toBe(false);
  }

  it('holds the turn when only one of two custom tool calls is answered, then resumes', async () => {
    const sessionId = await setUp([
      { id: 'custom_call_1', name: 'lookup_customer' },
      { id: 'custom_call_2', name: 'lookup_customer' },
    ], 'resumed');

    const first = eventIdOf(sessionId, 'custom_call_1');
    const second = eventIdOf(sessionId, 'custom_call_2');
    expect(publishedEventIds(sessionId)).toEqual([first, second]);

    await answerCustom(sessionId, 'custom_call_1');

    // Before this change: `failed` with "Tool result is missing for tool call
    // custom_call_2", because the custom family was not part of the gate at all.
    assertHeldWithoutFailure(sessionId);
    // The answer is recorded and the answered call has left the array.
    expect(publishedEventIds(sessionId)).not.toContain(first);
    expect(publishedEventIds(sessionId)).toContain(second);

    await answerCustom(sessionId, 'custom_call_2');
    await waitFor(() => resumed(sessionId), 'the resumed turn');
    expect(sessionError(sessionId)).toBeUndefined();
  });

  it('holds the turn when a gated call is answered while a custom call is parked', async () => {
    const sessionId = await setUp([
      { id: 'call_gated', name: 'bash' },
      { id: 'custom_call_1', name: 'lookup_customer' },
    ], 'resumed');

    const gated = eventIdOf(sessionId, 'call_gated');
    const custom = eventIdOf(sessionId, 'custom_call_1');
    expect(publishedEventIds(sessionId).sort()).toEqual([gated, custom].sort());

    await answerGated(sessionId, 'call_gated');

    // Before this change: the confirmation group held only the gated call, so
    // `groupComplete` was true and the turn started with the custom call
    // unanswered — "Tool result is missing for tool call custom_call_1".
    assertHeldWithoutFailure(sessionId);
    // The decision itself still executed and is paired.
    expect(events(sessionId).some(
      (e) => e.type === 'agent.tool_result' && (e.content?.[0] as any)?.tool_use_id === 'call_gated',
    )).toBe(true);
    expect(publishedEventIds(sessionId)).toEqual([custom]);

    await answerCustom(sessionId, 'custom_call_1');
    await waitFor(() => resumed(sessionId), 'the resumed turn');
    expect(sessionError(sessionId)).toBeUndefined();
  });

  it('holds the turn when a custom call is answered while a gated call is parked', async () => {
    const sessionId = await setUp([
      { id: 'call_gated', name: 'bash' },
      { id: 'custom_call_1', name: 'lookup_customer' },
    ], 'resumed');

    const gated = eventIdOf(sessionId, 'call_gated');
    const custom = eventIdOf(sessionId, 'custom_call_1');

    await answerCustom(sessionId, 'custom_call_1');

    // Before this change: custom results had no gate at all, so the turn started
    // with the gated call unanswered — "Tool result is missing for tool call
    // call_gated".
    assertHeldWithoutFailure(sessionId);
    expect(publishedEventIds(sessionId)).toEqual([gated]);

    await answerGated(sessionId, 'call_gated');
    await waitFor(() => resumed(sessionId), 'the resumed turn');
    expect(sessionError(sessionId)).toBeUndefined();
  });

  it('preserves the existing behaviour for two gated calls in one confirmation group', async () => {
    const sessionId = await setUp([
      { id: 'call_g1', name: 'bash' },
      { id: 'call_g2', name: 'bash' },
    ], 'resumed');

    const first = eventIdOf(sessionId, 'call_g1');
    const second = eventIdOf(sessionId, 'call_g2');
    expect(publishedEventIds(sessionId).sort()).toEqual([first, second].sort());

    await answerGated(sessionId, 'call_g1');

    // This shape already worked through `groupComplete`; it must not regress.
    assertHeldWithoutFailure(sessionId);
    expect(publishedEventIds(sessionId)).toEqual([second]);

    await answerGated(sessionId, 'call_g2');
    await waitFor(() => resumed(sessionId), 'the resumed turn');
    expect(sessionError(sessionId)).toBeUndefined();
  });

  it('resumes in one step for a single parked call, as before', async () => {
    const sessionId = await setUp([{ id: 'custom_call_1', name: 'lookup_customer' }], 'resumed');

    expect(publishedEventIds(sessionId)).toHaveLength(1);
    await answerCustom(sessionId, 'custom_call_1');

    await waitFor(() => resumed(sessionId), 'the resumed turn');
    expect(sessionError(sessionId)).toBeUndefined();
    expect(manager!.get(sessionId)?.status).not.toBe('requires_action');
  });

  it('resumes in one step for a single gated call, as before', async () => {
    const sessionId = await setUp([{ id: 'call_gated', name: 'bash' }], 'resumed');

    expect(publishedEventIds(sessionId)).toHaveLength(1);
    await answerGated(sessionId, 'call_gated');

    await waitFor(() => resumed(sessionId), 'the resumed turn');
    expect(sessionError(sessionId)).toBeUndefined();
    // The confirmation executed the tool and paired it.
    expect(events(sessionId).some(
      (e) => e.type === 'agent.tool_result' && (e.content?.[0] as any)?.tool_use_id === 'call_gated',
    )).toBe(true);
  });
});
