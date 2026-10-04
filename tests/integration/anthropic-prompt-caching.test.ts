/**
 * Integration test: a session on an `anthropic` provider sends the three
 * prompt-cache breakpoints WP4 D1 fixes — system prompt, last tool
 * definition, second-to-last message — and a non-Anthropic provider's
 * request body is unchanged.
 *
 * The wire is real end to end except the endpoint: the workspace's
 * `anthropic` provider config points at the conformance stub's
 * `/v1/messages` route, which records the body the AI SDK produced and
 * answers a minimal Anthropic stream.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { DefaultSessionExecutor } from '@/core/session/executor.js';
import { DefaultStrategy } from '@/strategy/default-strategy.js';
import { ModelRegistry } from '@/model/registry.js';
import { LocalSandboxProvider } from '@/sandbox/local-provider.js';
import { startStubModelServer, type StubModelServer } from '../conformance/support/stub-model-server.js';

/** Every `cache_control` value anywhere in a JSON body. */
function cacheControls(value: unknown): unknown[] {
  const found: unknown[] = [];
  JSON.parse(JSON.stringify(value ?? null), (key, entry) => {
    if (key === 'cache_control') found.push(entry);
    return entry;
  });
  return found;
}

async function waitFor<T>(probe: () => T | undefined, description: string, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function makeManager(db: Database, tmpDir: string, provider: Record<string, unknown>): SessionManager {
  const manager = new SessionManager(db);
  const registry = new ModelRegistry();
  registry.register({
    name: 'default',
    api_key: 'test-key',
    is_default: true,
    ...provider,
  } as never);
  manager.setExecutor(new DefaultSessionExecutor({
    agents: [{
      name: 'cache-agent',
      model: 'stub-model',
      system: 'You are a test agent.',
      tools: [{
        type: 'agent_toolset_20260401',
        default_config: { enabled: true, permission_policy: { type: 'always_allow' } },
        configs: [
          { name: 'glob', enabled: true },
          { name: 'read', enabled: true },
          { name: 'bash', enabled: true },
        ],
      }],
    }],
    modelRegistry: registry,
    sandboxProvider: new LocalSandboxProvider(tmpDir),
    strategy: new DefaultStrategy(),
    eventLogger: manager.getEventLogger(),
  }));
  return manager;
}

describe('Anthropic prompt caching breakpoints', () => {
  let db: Database;
  let tmpDir: string;
  let stub: StubModelServer;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-anthropic-cache-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_cache', 'cache-agent', '{}')`);
    stub = await startStubModelServer();
  });

  afterEach(async () => {
    await stub.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('marks the system prompt, the last tool, and the second-to-last message', async () => {
    const manager = makeManager(db, tmpDir, { provider: 'anthropic', base_url: stub.baseUrl });
    const session = manager.create({ agent: 'agent_cache' });

    await manager.sendEvent(session.id, {
      type: 'user.message',
      content: [{ type: 'text', text: 'first question' }],
    } as never);
    await waitFor(
      () => manager.getEventLogger().getEvents(session.id).find((event) => event.type === 'session.usage'),
      'first turn to idle',
    );

    await manager.sendEvent(session.id, {
      type: 'user.message',
      content: [{ type: 'text', text: 'second question' }],
    } as never);
    await waitFor(
      () => stub.requests.length >= 2 ? stub.requests[1] : undefined,
      'the second model request',
    );

    const body = stub.requests[1] as Record<string, any>;
    expect(cacheControls(body)).toEqual([
      { type: 'ephemeral' },
      { type: 'ephemeral' },
      { type: 'ephemeral' },
    ]);

    // System prompt arrives as the Anthropic block array, marker on it.
    const system = body.system as Array<Record<string, unknown>>;
    expect(Array.isArray(system)).toBe(true);
    expect(system[0].type).toBe('text');
    expect(system[0].cache_control).toEqual({ type: 'ephemeral' });

    // Exactly one tool carries the marker, and it is the last one sent.
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools.length).toBeGreaterThan(0);
    expect(tools[tools.length - 1].cache_control).toEqual({ type: 'ephemeral' });
    expect(tools.slice(0, -1).every((tool) => tool.cache_control === undefined)).toBe(true);

    // The message breakpoint lands on the previous turn's last message —
    // the assistant reply — never on the input that just arrived.
    const messages = body.messages as Array<Record<string, any>>;
    expect(messages.length).toBeGreaterThanOrEqual(3);
    const anchored = messages[messages.length - 2];
    expect(anchored.role).toBe('assistant');
    expect(anchored.content[anchored.content.length - 1].cache_control).toEqual({ type: 'ephemeral' });
    const last = messages[messages.length - 1];
    expect(last.content.every((part: Record<string, unknown>) => part.cache_control === undefined)).toBe(true);
  });

  it('sends no cache_control to a non-Anthropic provider', async () => {
    const manager = makeManager(db, tmpDir, { provider: 'openai_compatible', base_url: stub.baseUrl });
    const session = manager.create({ agent: 'agent_cache' });

    await manager.sendEvent(session.id, {
      type: 'user.message',
      content: [{ type: 'text', text: 'hello' }],
    } as never);
    await waitFor(
      () => manager.getEventLogger().getEvents(session.id).find((event) => event.type === 'session.usage'),
      'turn to idle',
    );

    // The OpenAI stub may issue a tool call first — every request it saw is
    // asserted, however many the turn produced.
    expect(stub.requests.length).toBeGreaterThan(0);
    for (const request of stub.requests) {
      expect(cacheControls(request)).toHaveLength(0);
    }
  });
});
