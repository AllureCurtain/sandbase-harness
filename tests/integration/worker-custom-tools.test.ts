/**
 * Integration test: worker-executed custom tools on self-hosted environments.
 *
 * Covers the full bridge an `agent.custom_tool_use` takes on a self-hosted
 * session: the strategy enqueues a `custom_tool` work item after persisting
 * the event, a worker claims and executes it through the same queue and the
 * same `/v1/x/worker` routes as every other kind, and the queue's completion
 * hook injects the outcome back as a `user.custom_tool_result` — through
 * `SessionManager.sendEvent`, so the parked call resolves under the same
 * admission rules a caller's answer faces.
 *
 * The delivery half is asserted through the real server wiring (the hook is
 * set in `createServer`), and the worker half through `executeWorkItem` and
 * `loadWorkerTools` directly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { LanguageModel } from 'ai';
import { Database } from '@/core/db/database.js';
import { WorkQueue, SelfHostedSandboxProvider } from '@/sandbox/self-hosted-provider.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { DefaultSessionExecutor } from '@/core/session/executor.js';
import { DefaultStrategy } from '@/strategy/default-strategy.js';
import { ModelRegistry } from '@/model/registry.js';
import { LocalSandboxProvider } from '@/sandbox/local-provider.js';
import { createServer } from '@/api/server.js';
import { createEnvironmentWorkerKey } from '@/core/auth/environment-worker-keys.js';
import { deliverCustomToolWorkResult } from '@/core/session/custom-tool-work.js';
import { executeWorkItem, loadWorkerTools } from '@/cli/worker-commands.js';
import type { EnvironmentConfig } from '@/types/sandbox.js';

const USAGE = { inputTokens: { total: 1 }, outputTokens: { total: 1 } };
const TOOL_CALLS = { unified: 'tool-calls', raw: 'tool_calls' } as const;
const STOP = { unified: 'stop', raw: 'stop' } as const;

function scriptedCustomModel(): LanguageModel {
  let turn = 0;
  return {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'scripted-custom-tool',
    supportedUrls: {},
    async doGenerate() {
      throw new Error('not used');
    },
    async doStream() {
      turn += 1;
      return {
        stream: new ReadableStream({
          start(controller) {
            if (turn === 1) {
              const args = JSON.stringify({ customer_id: 'cust_42' });
              controller.enqueue({ type: 'tool-input-start', id: 'custom_call_1', toolName: 'lookup_customer' });
              controller.enqueue({ type: 'tool-input-delta', id: 'custom_call_1', delta: args });
              controller.enqueue({ type: 'tool-input-end', id: 'custom_call_1' });
              controller.enqueue({
                type: 'tool-call',
                toolCallId: 'custom_call_1',
                toolName: 'lookup_customer',
                input: args,
              });
              controller.enqueue({ type: 'finish', finishReason: TOOL_CALLS, usage: USAGE });
            } else {
              controller.enqueue({ type: 'text-start', id: 'text_1' });
              controller.enqueue({ type: 'text-delta', id: 'text_1', delta: 'Customer lookup completed.' });
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

const CUSTOM_AGENT = {
  name: 'custom-agent',
  model: 'scripted',
  system: 'Use the customer lookup tool when needed.',
  tools: [{
    type: 'custom_toolset' as const,
    configs: [{
      name: 'lookup_customer',
      description: 'Look up a customer in the host application.',
      parameters: {
        type: 'object',
        properties: { customer_id: { type: 'string' } },
        required: ['customer_id'],
      },
    }],
  }],
};

function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error('timed out waiting for worker tool turn'));
      setTimeout(poll, 10);
    };
    poll();
  });
}

async function flushDelivery(): Promise<void> {
  // The completion hook's sendEvent is fire-and-forget; give it a few turns of
  // the event loop before asserting what it produced.
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
}

describe('worker-executed custom tools', () => {
  let db: Database;
  let tmpDir: string;
  let queue: WorkQueue;
  let manager: SessionManager;
  let executor: DefaultSessionExecutor;
  let app: ReturnType<typeof createServer>;
  let workerKey: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-wct-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.prepare("INSERT INTO environments (id, name, description, config, metadata) VALUES ('env_default', 'local', '', '{}', '{}')").run();
    db.prepare("INSERT INTO environments (id, name, description, config, metadata) VALUES ('env_sh', 'sh', '', '{\"sandbox_provider\":\"self_hosted\"}', '{}')").run();
    db.prepare("INSERT INTO agents (id, name, definition) VALUES ('agent_custom', 'custom-agent', '{}')").run();
    queue = new WorkQueue(db);
    manager = new SessionManager(db);
    const registry = new ModelRegistry();
    registry.register({ name: 'scripted', provider: 'openai', model: 'scripted', is_default: true });
    const model = scriptedCustomModel();
    (registry as any).createModel = () => model;
    executor = new DefaultSessionExecutor({
      agents: [CUSTOM_AGENT],
      modelRegistry: registry,
      sandboxProvider: new SelfHostedSandboxProvider(queue),
      resolveEnvironmentConfig: () => ({ name: 'sh', sandbox_provider: 'self_hosted', timeout: 300 } as EnvironmentConfig),
      strategy: new DefaultStrategy(),
      eventLogger: manager.getEventLogger(),
    });
    manager.setExecutor(executor);
    app = createServer({
      db,
      sessionManager: manager,
      agents: [],
      reloadAgents: () => ({ agents: [], errors: [] }),
      consoleRoot: null,
      workQueue: queue,
    });
    workerKey = createEnvironmentWorkerKey(db, 'env_sh', { name: 'worker' }).secret_key;
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function parkSessionOnCustomCall(): Promise<string> {
    const session = manager.create({ agent: 'agent_custom', environmentId: 'env_sh' });
    await manager.sendEvent(session.id, {
      type: 'user.message',
      content: [{ type: 'text', text: 'Look up customer cust_42.' }],
    });
    await waitFor(() => manager.get(session.id)?.status === 'requires_action'
      && queue.list().some((item) => item.sessionId === session.id && item.kind === 'custom_tool'));
    return session.id;
  }

  function enqueuedItem(sessionId: string) {
    const item = queue.list().find((i) => i.sessionId === sessionId && i.kind === 'custom_tool');
    expect(item).toBeDefined();
    return item!;
  }

  async function claimAndComplete(result: unknown, failed = false) {
    const claim = await app.request('/v1/x/worker/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ worker_id: 'worker_1', environment_id: 'env_sh', environment_key: workerKey }),
    });
    expect(claim.status).toBe(200);
    const item = await claim.json() as { id: string; kind: string };
    expect(item.kind).toBe('custom_tool');
    const complete = await app.request('/v1/x/worker/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: item.id, worker_id: 'worker_1', result, ...(failed ? { failed: true } : {}) }),
    });
    expect(complete.status).toBe(200);
    return item.id;
  }

  it('enqueues the call for a worker and resumes the session on its answer', async () => {
    const sessionId = await parkSessionOnCustomCall();
    const item = enqueuedItem(sessionId);
    expect(item.payload.tool_name).toBe('lookup_customer');
    expect(item.payload.tool_use_id).toBe('custom_call_1');
    expect(item.payload.input).toEqual({ customer_id: 'cust_42' });

    await claimAndComplete({ content: [{ type: 'text', text: '{"name":"Ada"}' }] });

    await waitFor(() => manager.getEventLogger().getEvents(sessionId)
      .some((event) => event.type === 'user.custom_tool_result'));
    await waitFor(() => manager.get(sessionId)?.status === 'paused');

    const events = manager.getEventLogger().getEvents(sessionId);
    const results = events.filter((event) => event.type === 'user.custom_tool_result');
    expect(results).toHaveLength(1);
    expect(results[0].metadata?.custom_tool_use_id).toBe('custom_call_1');
    expect(events.some((event) => event.type === 'agent.message'
      && JSON.stringify(event.content).includes('Customer lookup completed.'))).toBe(true);
    await executor.cleanupSession(sessionId);
  });

  it('delivers a worker-declared tool error as an is_error result', async () => {
    const sessionId = await parkSessionOnCustomCall();
    await claimAndComplete({ is_error: true, content: [{ type: 'text', text: 'customer backend is down' }] });

    await waitFor(() => manager.getEventLogger().getEvents(sessionId)
      .some((event) => event.type === 'user.custom_tool_result'));
    await waitFor(() => manager.get(sessionId)?.status === 'paused');

    const result = manager.getEventLogger().getEvents(sessionId)
      .find((event) => event.type === 'user.custom_tool_result');
    expect(result?.metadata?.is_error).toBe(true);
    expect(JSON.stringify(result?.content)).toContain('customer backend is down');
    await executor.cleanupSession(sessionId);
  });

  it('turns a failed completion into an error result, not a missing answer', async () => {
    const sessionId = await parkSessionOnCustomCall();
    await claimAndComplete({ message: 'worker process died' }, true);

    await waitFor(() => manager.getEventLogger().getEvents(sessionId)
      .some((event) => event.type === 'user.custom_tool_result'));

    const result = manager.getEventLogger().getEvents(sessionId)
      .find((event) => event.type === 'user.custom_tool_result');
    expect(result?.metadata?.is_error).toBe(true);
    expect(JSON.stringify(result?.content)).toContain('worker process died');
    await executor.cleanupSession(sessionId);
  });

  it('refuses a second completion and cannot answer the call twice', async () => {
    const sessionId = await parkSessionOnCustomCall();
    const itemId = await claimAndComplete({ content: [{ type: 'text', text: 'first' }] });

    const again = await app.request('/v1/x/worker/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: itemId, worker_id: 'worker_1', result: { content: [{ type: 'text', text: 'second' }] } }),
    });
    expect(again.status).toBe(409);

    await flushDelivery();
    const results = manager.getEventLogger().getEvents(sessionId)
      .filter((event) => event.type === 'user.custom_tool_result');
    expect(results).toHaveLength(1);
    await executor.cleanupSession(sessionId);
  });

  it('records the item but injects nothing after the session ended', async () => {
    const sessionId = await parkSessionOnCustomCall();
    // Claim while the session is live - a claim on a dead session's work is
    // already refused by the queue itself and is not what this tests.
    const claim = await app.request('/v1/x/worker/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ worker_id: 'worker_1', environment_id: 'env_sh', environment_key: workerKey }),
    });
    const item = await claim.json() as { id: string };
    const warnings: string[] = [];
    queue.onItemCompleted = (completed) => {
      if (completed.kind !== 'custom_tool') return;
      void deliverCustomToolWorkResult(
        {
          sendEvent: (sid, event) => manager.sendEvent(sid, event),
          warn: (message) => warnings.push(message),
        },
        completed,
      );
    };
    db.prepare("UPDATE sessions SET status = 'cancelled' WHERE id = ?").run(sessionId);

    const complete = await app.request('/v1/x/worker/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: item.id, worker_id: 'worker_1', result: { content: [{ type: 'text', text: 'too late' }] } }),
    });
    expect(complete.status).toBe(200);

    await flushDelivery();
    expect(queue.get(item.id)?.status).toBe('applied');
    expect(manager.getEventLogger().getEvents(sessionId)
      .filter((event) => event.type === 'user.custom_tool_result')).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('does not enqueue worker work for a session on a local environment', async () => {
    const localExecutor = new DefaultSessionExecutor({
      agents: [CUSTOM_AGENT],
      modelRegistry: (() => {
        const registry = new ModelRegistry();
        registry.register({ name: 'scripted', provider: 'openai', model: 'scripted', is_default: true });
        (registry as any).createModel = () => scriptedCustomModel();
        return registry;
      })(),
      sandboxProvider: new LocalSandboxProvider(tmpDir),
      resolveEnvironmentConfig: () => ({ name: 'local', sandbox_provider: 'local' } as EnvironmentConfig),
      strategy: new DefaultStrategy(),
      eventLogger: manager.getEventLogger(),
    });
    const localManager = new SessionManager(db);
    localManager.setExecutor(localExecutor);

    const session = localManager.create({ agent: 'agent_custom' });
    await localManager.sendEvent(session.id, {
      type: 'user.message',
      content: [{ type: 'text', text: 'Look up customer cust_42.' }],
    });
    await waitFor(() => localManager.get(session.id)?.status === 'requires_action');

    expect(localManager.getEventLogger().getEvents(session.id)
      .some((event) => event.type === 'agent.custom_tool_use')).toBe(true);
    expect(queue.list().filter((item) => item.sessionId === session.id)).toHaveLength(0);
    await localExecutor.cleanupSession(session.id);
  });
});

describe('worker custom tool execution', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'ma-wctu-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  const item = (payload: Record<string, unknown>) => ({
    id: 'work_1',
    kind: 'custom_tool' as const,
    payload,
  });

  it('runs a declared handler and normalizes a string result to a text block', async () => {
    const result = await executeWorkItem(item({ tool_name: 'lookup', tool_use_id: 'call_1', input: { id: 'c1' } }), tmpDir, undefined, {
      lookup: async (input, ctx) => {
        expect(input).toEqual({ id: 'c1' });
        expect(ctx.toolUseId).toBe('call_1');
        return '{"name":"Ada"}';
      },
    });
    expect(result).toEqual({ content: [{ type: 'text', text: '{"name":"Ada"}' }] });
  });

  it('passes a {content: [...]} handler result through, with is_error preserved', async () => {
    const content = [{ type: 'text', text: 'partial' }, { type: 'text', text: 'second' }];
    const result = await executeWorkItem(item({ tool_name: 'lookup', tool_use_id: 'call_1', input: {} }), tmpDir, undefined, {
      lookup: () => ({ content, is_error: true }),
    });
    expect(result).toEqual({ content, is_error: true });
  });

  it('folds a non-block handler result into a JSON text block', async () => {
    const result = await executeWorkItem(item({ tool_name: 'lookup', tool_use_id: 'call_1', input: {} }), tmpDir, undefined, {
      lookup: () => ({ name: 'Ada', id: 42 }),
    });
    expect(result).toEqual({ content: [{ type: 'text', text: '{"name":"Ada","id":42}' }] });
  });

  it('answers a call for a tool the worker does not declare with an error result', async () => {
    const result = await executeWorkItem(item({ tool_name: 'undeclared', tool_use_id: 'call_1', input: {} }), tmpDir, undefined, {
      lookup: () => 'never called',
    });
    expect(result).toEqual({
      is_error: true,
      content: [{ type: 'text', text: 'Custom tool "undeclared" is not declared by this worker.' }],
    });
  });

  it('answers with an error result when the handler throws', async () => {
    const result = await executeWorkItem(item({ tool_name: 'lookup', tool_use_id: 'call_1', input: {} }), tmpDir, undefined, {
      lookup: () => { throw new Error('connection refused'); },
    });
    expect(result).toEqual({
      is_error: true,
      content: [{ type: 'text', text: 'connection refused' }],
    });
  });

  it('an empty registry still answers rather than failing the item', async () => {
    const result = await executeWorkItem(item({ tool_name: 'anything', tool_use_id: 'call_1', input: {} }), tmpDir);
    expect((result as { is_error?: boolean }).is_error).toBe(true);
  });

  it('loads a tools module from its default export and rejects invalid shapes', async () => {
    const modulePath = join(tmpDir, 'tools.mjs');
    writeFileSync(modulePath, 'export default { greet: async (input) => `hi ${input.name}` };\n');
    const tools = await loadWorkerTools(modulePath);
    expect(Object.keys(tools)).toEqual(['greet']);
    await expect(tools.greet({ name: 'Ada' }, { toolUseId: 'x' })).resolves.toBe('hi Ada');

    const namedPath = join(tmpDir, 'tools-named.mjs');
    writeFileSync(namedPath, 'export const tools = { ping: () => "pong" };\n');
    expect(Object.keys(await loadWorkerTools(namedPath))).toEqual(['ping']);

    const badPath = join(tmpDir, 'tools-bad.mjs');
    writeFileSync(badPath, 'export default { broken: "not a function" };\n');
    await expect(loadWorkerTools(badPath)).rejects.toThrow(/not a function/);

    const missingPath = join(tmpDir, 'tools-missing.mjs');
    writeFileSync(missingPath, 'export const nothing = 1;\n');
    await expect(loadWorkerTools(missingPath)).rejects.toThrow(/default export/);
  });
});
