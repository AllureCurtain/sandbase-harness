/**
 * Integration test: a `vendor/model` agent model reaches the provider unchanged.
 *
 * `tests/unit/model-registry.test.ts` pins the request body a single
 * `resolveModelConfig` call produces. This drives the whole path instead — agent
 * definition, registry, AI SDK client, HTTP request, event log — because the
 * defect was a value that changed between those layers: the namespace was
 * stripped during resolution, so the endpoint was addressed with an id it does
 * not serve and every `vendor/model` model was unreachable.
 *
 * A live gateway is not reachable from a test, so the HTTP boundary is stubbed.
 * What is stubbed is only the socket: the agent model, the resolution, the
 * OpenAI-compatible request, the streamed answer and the recorded `model_used`
 * are all the real ones.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { DefaultSessionExecutor } from '@/core/session/executor.js';
import { DefaultStrategy } from '@/strategy/default-strategy.js';
import { ModelRegistry } from '@/model/registry.js';
import { LocalSandboxProvider } from '@/sandbox/local-provider.js';
import { toApiEvent } from '@/api/standard.js';
import type { Session, SessionEvent } from '@/types/session.js';

/** A model id of the shape every OpenRouter-style gateway addresses models by. */
const GATEWAY_MODEL = 'deepseek/deepseek-v4-flash';
const GATEWAY_BASE_URL = 'https://gateway.invalid/v1';

/** The OpenAI-compatible SSE stream one agent message is assembled from. */
function sseBody(text: string): string {
  const chunk = (choices: unknown[], usage?: unknown) => `data: ${JSON.stringify({
    id: 'chatcmpl_1',
    object: 'chat.completion.chunk',
    created: 0,
    model: GATEWAY_MODEL,
    choices,
    ...(usage ? { usage } : {}),
  })}`;
  return [
    chunk([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]),
    chunk([{ index: 0, delta: { content: text }, finish_reason: null }]),
    chunk([{ index: 0, delta: {}, finish_reason: 'stop' }], { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }),
    'data: [DONE]',
  ].join('\n\n') + '\n\n';
}

async function waitFor<T>(probe: () => T | undefined, description: string, timeoutMs = 3_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('qualified model references reach the provider', () => {
  let db: Database;
  let manager: SessionManager;
  let tmpDir: string;
  let requests: Array<{ url: string; body: Record<string, unknown> }>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-model-qualified-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_gateway', 'gateway-agent', '{}')`);
    manager = new SessionManager(db);

    requests = [];
    vi.stubGlobal('fetch', async (url: unknown, init: { body?: string }) => {
      requests.push({ url: String(url), body: JSON.parse(init?.body ?? '{}') });
      return new Response(sseBody('hello from the gateway'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** A workspace whose single configured provider is an OpenAI-compatible gateway. */
  function gatewayRegistry(): ModelRegistry {
    const registry = new ModelRegistry();
    registry.register({
      name: 'default',
      provider: 'openai_compatible',
      api_key: 'test-key',
      base_url: GATEWAY_BASE_URL,
      is_default: true,
    });
    return registry;
  }

  /** Run one real turn for `agentModel` and return the settled session and log. */
  async function runTurn(
    agentModel: string,
    registry: ModelRegistry,
  ): Promise<{ session: Session; events: SessionEvent[] }> {
    manager.setExecutor(new DefaultSessionExecutor({
      agents: [{ name: 'gateway-agent', model: agentModel, system: 'p' }],
      modelRegistry: registry,
      sandboxProvider: new LocalSandboxProvider(tmpDir),
      strategy: new DefaultStrategy(),
      eventLogger: manager.getEventLogger(),
    }));

    const created = manager.create({ agent: 'agent_gateway' });
    await manager.sendEvent(created.id, {
      type: 'user.message',
      content: [{ type: 'text', text: 'hi' }],
    } as never);

    // The session is created `queued`; both a completed and a failed turn leave
    // it, so waiting for the log to settle is what decides when to assert.
    await waitFor(
      () => (manager.get(created.id)!.status !== 'queued' && manager.get(created.id)!.status !== 'running'
        ? true
        : undefined),
      'the turn to settle',
    );

    return { session: manager.get(created.id)!, events: manager.getEventLogger().getEvents(created.id) };
  }

  it('sends the vendor-namespaced model id and records it as model_used', async () => {
    const { session, events } = await runTurn(GATEWAY_MODEL, gatewayRegistry());

    // The endpoint was addressed with the whole reference, not a truncated id.
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(`${GATEWAY_BASE_URL}/chat/completions`);
    expect(requests[0].body['model']).toBe(GATEWAY_MODEL);

    // `model_used` names the model the provider was actually asked for, so the
    // usage and cost records built from this event are attributable.
    const span = events.find((event) => event.type === 'span.model_request_end');
    expect(span?.modelUsed).toBe(GATEWAY_MODEL);

    // One real turn: an answer, and a session waiting for the next event.
    expect(events.some((event) => event.type === 'agent.message')).toBe(true);
    expect(events.some((event) => event.type === 'session.status_idle')).toBe(true);
    expect(events.some((event) => event.type === 'session.error')).toBe(false);
    expect(session.status).toBe('paused');
  });

  it('reports a namespace the configured endpoint cannot serve as a fixable error', async () => {
    // Only an Anthropic provider is configured, and `openai/gpt-5.5` names the
    // other wire protocol. Forwarding it would answer with an upstream 404 that
    // hides the real problem; the turn names the missing provider instead.
    const registry = new ModelRegistry();
    registry.register({
      name: 'default',
      provider: 'anthropic',
      model: 'claude-sonnet',
      api_key: 'test-key',
      is_default: true,
    });

    const { session, events } = await runTurn('openai/gpt-5.5', registry);

    const error = events.find((event) => event.type === 'session.error');
    expect(error, 'no session.error was appended').toBeDefined();
    expect(toApiEvent(error!).error).toMatchObject({
      type: 'model_provider_not_configured',
      retry_status: 'not_retryable',
    });

    // A configuration mistake the caller can repair leaves the session
    // resumable: `session.status_terminated` would report it as over.
    expect(events.some((event) => event.type === 'session.status_terminated')).toBe(false);
    expect(session.status).toBe('paused');
    expect(requests).toHaveLength(0);
  });

  it('reports a model with no configured provider as a distinct fixable error', async () => {
    const { session, events } = await runTurn('gpt-4o', new ModelRegistry());

    const error = events.find((event) => event.type === 'session.error');
    expect(toApiEvent(error!).error).toMatchObject({
      type: 'model_not_found',
      retry_status: 'not_retryable',
    });
    expect(session.status).toBe('paused');
    expect(requests).toHaveLength(0);
  });
});
