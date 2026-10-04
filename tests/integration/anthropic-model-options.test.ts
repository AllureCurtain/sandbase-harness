/**
 * Integration test: an Anthropic-provider session carries the agent's
 * `model.effort`/`model.speed` onto the wire — `output_config.effort`,
 * `speed`, the `fast-mode` beta header, and adaptive thinking — gated by the
 * model capability table, while a model the table marks incapable (or does
 * not know) receives none of them.
 *
 * The wire is real end to end except the endpoint: the workspace's
 * `anthropic` provider config points at the conformance stub's
 * `/v1/messages` route, which records the body and headers the AI SDK
 * produced and answers a minimal Anthropic stream.
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
import type { AgentDefinition } from '@/types/agent.js';
import { startStubModelServer, type StubModelServer } from '../conformance/support/stub-model-server.js';

async function waitFor<T>(probe: () => T | undefined, description: string, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function makeManager(db: Database, tmpDir: string, agent: AgentDefinition): SessionManager {
  const manager = new SessionManager(db);
  const registry = new ModelRegistry();
  registry.register({
    name: 'default',
    api_key: 'test-key',
    is_default: true,
    provider: 'anthropic',
    base_url: stub!.baseUrl,
  } as never);
  manager.setExecutor(new DefaultSessionExecutor({
    agents: [agent],
    modelRegistry: registry,
    sandboxProvider: new LocalSandboxProvider(tmpDir),
    strategy: new DefaultStrategy(),
    eventLogger: manager.getEventLogger(),
  }));
  return manager;
}

async function runOneTurn(manager: SessionManager, agentName: string) {
  const session = manager.create({ agent: agentName });
  await manager.sendEvent(session.id, {
    type: 'user.message',
    content: [{ type: 'text', text: 'hello' }],
  } as never);
  await waitFor(
    () => manager.getEventLogger().getEvents(session.id).find((event) => event.type === 'session.usage'),
    'turn to idle',
  );
  return session;
}

let stub: StubModelServer;

describe('Anthropic model options reach the request', () => {
  let db: Database;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-anthropic-options-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_opts', 'opts-agent', '{}')`);
    stub = await startStubModelServer();
  });

  afterEach(async () => {
    await stub.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sends effort, fast speed with the beta header, and adaptive thinking for a capable model', async () => {
    const manager = makeManager(db, tmpDir, {
      name: 'opts-agent',
      model: 'claude-opus-5',
      system: 'You are a test agent.',
      model_config: { id: 'claude-opus-5', speed: 'fast', effort: 'high' },
    } as AgentDefinition);

    const session = await runOneTurn(manager, 'agent_opts');
    const body = stub.requests.at(-1);
    expect(body).toBeTruthy();
    expect(body?.output_config?.effort).toBe('high');
    expect(body?.thinking).toEqual({ type: 'adaptive', display: 'omitted' });
    expect(body?.speed).toBe('fast');
    // The provider marks a fast request with its beta header.
    const beta = body?.headers?.['anthropic-beta'];
    const betas = Array.isArray(beta) ? beta : [beta];
    expect(betas.join(',')).toContain('fast-mode-2026-02-01');

    // The paired span reports the tier the request ran under.
    const endSpan = manager.getEventLogger().getEvents(session.id)
      .find((event) => event.type === 'span.model_request_end');
    expect(endSpan?.speed).toBe('fast');
  });

  it('sends adaptive thinking but no effort or speed for a capable model with defaults', async () => {
    const manager = makeManager(db, tmpDir, {
      name: 'opts-agent',
      model: 'claude-sonnet-4-6',
      system: 'You are a test agent.',
      model_config: { id: 'claude-sonnet-4-6', speed: 'standard' },
    } as AgentDefinition);

    await runOneTurn(manager, 'agent_opts');
    const body = stub.requests.at(-1);
    expect(body?.thinking).toEqual({ type: 'adaptive', display: 'omitted' });
    expect(body?.output_config).toBeUndefined();
    expect(body?.speed).toBeUndefined();
  });

  it('sends no Anthropic options for a listed model that takes none', async () => {
    const manager = makeManager(db, tmpDir, {
      name: 'opts-agent',
      model: 'claude-haiku-4-5',
      system: 'You are a test agent.',
      model_config: { id: 'claude-haiku-4-5', speed: 'standard' },
    } as AgentDefinition);

    await runOneTurn(manager, 'agent_opts');
    const body = stub.requests.at(-1);
    expect(body?.thinking).toBeUndefined();
    expect(body?.output_config).toBeUndefined();
    expect(body?.speed).toBeUndefined();
  });

  it('sends no Anthropic options for a model the table does not know', async () => {
    const manager = makeManager(db, tmpDir, {
      name: 'opts-agent',
      model: 'claude-next-9',
      system: 'You are a test agent.',
      model_config: { id: 'claude-next-9', speed: 'standard', effort: 'high' },
    } as AgentDefinition);

    await runOneTurn(manager, 'agent_opts');
    const body = stub.requests.at(-1);
    expect(body?.thinking).toBeUndefined();
    expect(body?.output_config).toBeUndefined();
    expect(body?.speed).toBeUndefined();
  });
});
