/**
 * Integration test: an approval-gated tool call is addressed by its **event** id.
 *
 * The published contract puts the `tool_use` event id in circulation. The client
 * is told the blocking events' ids are in `stop_reason.event_ids`
 * (`会话事件流.md:1876`, `权限策略.md:668`), it passes each entry straight back as
 * the answer parameter (`:1908`), and `权限策略.md:669` states that parameter
 * carries the **event** id. The samples bind it to the event object's own id
 * (`tool_use_id: agent_tool_use_event.id`, `:730`).
 *
 * The runtime used to circulate the `tool_use` **block** id instead, on both
 * sides: `lifecycleMetadataFor` reported `block.id` in `event_ids`, and both the
 * validator and the executor matched `block.id`. So a conforming client read an
 * id out of `event_ids`, sent it back exactly as instructed, and was refused with
 * "the tool call is not awaiting approval" — the published approval loop could
 * not complete.
 *
 * These assertions pin both halves of the exchange: the id `event_ids` reports is
 * the event's own id, and a decision sent with that id is accepted and executes.
 * They also pin that the widening did not move authority or corrupt the log: the
 * block id still works, the persisted and paired ids stay the block id (the
 * model-facing projection pairs a tool result to its call by tool-call id), a
 * second decision for the same call is still refused whichever spelling it uses,
 * and an id naming neither is still refused.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager, type SessionExecutor } from '@/core/session/session-manager.js';
import { DefaultSessionExecutor } from '@/core/session/executor.js';
import { ModelRegistry } from '@/model/registry.js';
import { LocalSandboxProvider } from '@/sandbox/local-provider.js';
import { createServer } from '@/api/server.js';
import type { AgentStrategy, StrategyContext } from '@/types/strategy.js';
import type { LanguageModel } from 'ai';

async function waitFor<T>(probe: () => T | undefined | null, what: string, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined && value !== null) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function fakeModel(): LanguageModel {
  return {
    specificationVersion: 'v4', provider: 'test', modelId: 't',
    supportedUrls: {},
    async doGenerate() { return { content: [], finishReason: { unified: 'stop', raw: 'stop' }, usage: {}, warnings: [] } as any; },
    async doStream() { throw new Error('unused'); },
  } as unknown as LanguageModel;
}

/** Noop strategy so the model turn after a confirmation is a no-op. */
class NoopStrategy implements AgentStrategy {
  readonly name = 'noop';
  // eslint-disable-next-line require-yield
  async *execute(_ctx: StrategyContext) { return; }
}

describe('Approval-gated call addressed by event id', () => {
  let db: Database;
  let manager: SessionManager;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-event-id-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_bash', 'bash-agent', '{}')`);

    manager = new SessionManager(db);
    const modelRegistry = new ModelRegistry();
    (modelRegistry as any).createModel = () => fakeModel();
    manager.setExecutor(new DefaultSessionExecutor({
      agents: [{
        name: 'bash-agent',
        model: 'm',
        system: 'p',
        tools: [{
          type: 'agent_toolset_20260401',
          default_config: { enabled: true, permission_policy: { type: 'always_allow' } },
          configs: [{ name: 'bash', enabled: true, permission_policy: { type: 'always_ask' } }],
        }],
      }],
      modelRegistry,
      sandboxProvider: new LocalSandboxProvider(tmpDir),
      strategy: new NoopStrategy(),
      eventLogger: manager.getEventLogger(),
    }));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const BLOCK_ID = 'call_1';
  const GROUP_ID = 'confirm_seed';

  /** Seed the pending approval-gated call and return the event id that carries it. */
  function seedPending(sessionId: string): string {
    return manager.getEventLogger().append(sessionId, {
      type: 'agent.tool_use',
      content: [{
        type: 'tool_use',
        id: BLOCK_ID,
        name: 'bash',
        input: { command: 'echo confirmed' },
        requires_confirmation: true,
        confirmation_group_id: GROUP_ID,
      }],
      metadata: { confirmation_group_id: GROUP_ID },
    }).id;
  }

  /** A session left awaiting a decision by a prior turn, with the call pending. */
  function sessionAwaitingApproval(): { id: string; eventId: string } {
    const session = manager.create({ agent: 'agent_bash' });
    db.prepare(`UPDATE sessions SET status='requires_action' WHERE id=?`).run(session.id);
    return { id: session.id, eventId: seedPending(session.id) };
  }

  function events(sessionId: string) {
    return manager.getEventLogger().getEvents(sessionId);
  }

  function toolResult(sessionId: string, toolUseId: string) {
    return events(sessionId)
      .find((e) => e.type === 'agent.tool_result' && (e.content?.[0] as any)?.tool_use_id === toolUseId);
  }

  function confirmationEvent(sessionId: string) {
    return events(sessionId).find((e) => e.type === 'user.tool_confirmation');
  }

  it('reports the event id, not the block id, in stop_reason.event_ids', async () => {
    // The array is written by the status transition, from the log as it stands at
    // that moment, so the gated call has to be in the log before the signal. This
    // executor writes a real gated `agent.tool_use` and then raises the same
    // `onRequiresAction` a strategy raises, which is the published path into
    // `requires_action`.
    let seededEventId = '';
    const signallingExecutor: SessionExecutor = {
      // eslint-disable-next-line require-yield
      async *execute(session, _event, options) {
        seededEventId = seedPending(session.id);
        options?.onRequiresAction?.();
        return;
      },
    };
    manager.setExecutor(signallingExecutor);

    const session = manager.create({ agent: 'agent_bash' });
    await manager.sendEvent(session.id, {
      type: 'user.message', content: [{ type: 'text', text: 'go' }],
    } as any);
    await waitFor(
      () => (manager.get(session.id)?.status === 'requires_action' ? 'requires_action' : undefined),
      'session status requires_action',
    );

    const idle = events(session.id).find((e) => e.type === 'session.status_idle');
    expect(idle).toBeDefined();
    const reported = (idle!.metadata?.stop_reason as any).event_ids as string[];

    // What the array names is the event's own id — the value the event listing
    // reports and the value the published client sends back.
    expect(reported).toEqual([seededEventId]);
    expect(reported[0]).not.toBe(BLOCK_ID);
    expect(reported[0]).toMatch(/^sevt_/);
  });

  it('accepts a decision naming the event id and executes the tool', async () => {
    const { id: sessionId, eventId } = sessionAwaitingApproval();

    await manager.sendEvent(sessionId, {
      type: 'user.tool_confirmation', tool_use_id: eventId, result: 'allow',
    } as any);

    const result = await waitFor(() => toolResult(sessionId, BLOCK_ID), 'the tool result for the call');
    expect((result.content![0] as any).content).toContain('confirmed');
    expect((result.content![0] as any).is_error).toBeFalsy();
  });

  it('still accepts a decision naming the block id', async () => {
    const { id: sessionId } = sessionAwaitingApproval();

    await manager.sendEvent(sessionId, {
      type: 'user.tool_confirmation', tool_use_id: BLOCK_ID, result: 'allow',
    } as any);

    const result = await waitFor(() => toolResult(sessionId, BLOCK_ID), 'the tool result for the call');
    expect((result.content![0] as any).content).toContain('confirmed');
  });

  it('appends the deny result under the block id so the model-facing pairing survives', async () => {
    const { id: sessionId, eventId } = sessionAwaitingApproval();

    await manager.sendEvent(sessionId, {
      type: 'user.tool_confirmation', tool_use_id: eventId, result: 'deny', deny_message: 'nope',
    } as any);

    const result = await waitFor(() => toolResult(sessionId, BLOCK_ID), 'the deny result for the call');
    expect((result.content![0] as any).is_error).toBe(true);
    expect((result.content![0] as any).content).toContain('nope');
    // Nothing was paired against the event id: a tool result carrying it would
    // leave the tool_use block unpaired in the next projection.
    expect(toolResult(sessionId, eventId)).toBeUndefined();
  });

  it('records the block id in the confirmation metadata, not the id the caller sent', async () => {
    const { id: sessionId, eventId } = sessionAwaitingApproval();

    await manager.sendEvent(sessionId, {
      type: 'user.tool_confirmation', tool_use_id: eventId, result: 'allow',
    } as any);

    await waitFor(() => confirmationEvent(sessionId), 'the confirmation event');
    expect(confirmationEvent(sessionId)!.metadata?.tool_use_id).toBe(BLOCK_ID);
    // Let the confirmed turn finish: the local sandbox is still holding its
    // directory until the tool returns, and leaving it running makes teardown a
    // race rather than an assertion.
    await waitFor(() => toolResult(sessionId, BLOCK_ID), 'the tool result for the call');
  });

  it('refuses a second decision for the same call even when it uses the other spelling', async () => {
    const { id: sessionId, eventId } = sessionAwaitingApproval();

    await manager.sendEvent(sessionId, {
      type: 'user.tool_confirmation', tool_use_id: BLOCK_ID, result: 'allow',
    } as any);
    await waitFor(() => toolResult(sessionId, BLOCK_ID), 'the tool result for the call');

    // The other spelling must not be a way to answer the same call twice.
    await expect(manager.sendEvent(sessionId, {
      type: 'user.tool_confirmation', tool_use_id: eventId, result: 'deny',
    } as any)).rejects.toThrow(/not awaiting approval/);
  });

  it('refuses an id that names neither the call nor a pending call', async () => {
    const { id: sessionId } = sessionAwaitingApproval();

    await expect(manager.sendEvent(sessionId, {
      type: 'user.tool_confirmation', tool_use_id: 'sevt_not_a_real_call', result: 'allow',
    } as any)).rejects.toThrow(/not awaiting approval/);
  });

  it('does not let an id name a call that is not awaiting a decision', async () => {
    const { id: sessionId, eventId } = sessionAwaitingApproval();
    // Resolve the call first, then try to decide it by its event id.
    await manager.sendEvent(sessionId, {
      type: 'user.tool_confirmation', tool_use_id: BLOCK_ID, result: 'allow',
    } as any);
    await waitFor(() => toolResult(sessionId, BLOCK_ID), 'the tool result for the call');

    await expect(manager.sendEvent(sessionId, {
      type: 'user.tool_confirmation', tool_use_id: eventId, result: 'deny',
    } as any)).rejects.toThrow(/not awaiting approval/);
  });

  it('refuses a plain-text error envelope naming an unknown id over the real route', async () => {
    const { id: sessionId } = sessionAwaitingApproval();
    const app = createServer({
      db, sessionManager: manager, agents: [],
      reloadAgents: () => ({ agents: [], errors: [] }), consoleRoot: null,
    });

    const res = await app.request(`/v1/sessions/${sessionId}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        events: [{ type: 'user.tool_confirmation', tool_use_id: 'sevt_nope', result: 'allow' }],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.type).toBe('invalid_request');
    expect(body.error.message).toMatch(/not awaiting approval/);
  });
});
