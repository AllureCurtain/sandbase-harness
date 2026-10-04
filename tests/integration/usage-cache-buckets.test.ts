/**
 * Integration test: a provider that reports prompt-cache buckets sees them
 * recorded, aggregated, priced, and projected — and the uncached share alone
 * lands in `input_tokens`.
 *
 * The socket is the only thing stubbed (same pattern as
 * `usage-per-model-request.test.ts`): the agent definition, model resolution,
 * OpenAI-compatible request, streamed answer, the usage the provider reports
 * in its final chunk, the span row, the session aggregate, and the projected
 * wire event are all real.
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
import { toApiEvent, toApiSession } from '@/api/standard.js';

const GATEWAY_MODEL = 'deepseek/deepseek-v4-flash';
const GATEWAY_BASE_URL = 'https://gateway.invalid/v1';
/** One request: 1000 input, 800 of it read from cache, 100 written to it. */
const PROMPT_TOKENS = 1000;
const CACHED_TOKENS = 800;
const CACHE_WRITE_TOKENS = 100;
const COMPLETION_TOKENS = 4;
const UNCACHED_TOKENS = PROMPT_TOKENS - CACHED_TOKENS - CACHE_WRITE_TOKENS;

/** One OpenAI-compatible stream, whose final chunk carries the provider's usage. */
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
    chunk([{ index: 0, delta: {}, finish_reason: 'stop' }], {
      prompt_tokens: PROMPT_TOKENS,
      prompt_tokens_details: {
        cached_tokens: CACHED_TOKENS,
        cache_write_tokens: CACHE_WRITE_TOKENS,
      },
      completion_tokens: COMPLETION_TOKENS,
      total_tokens: PROMPT_TOKENS + COMPLETION_TOKENS,
    }),
    'data: [DONE]',
  ].join('\n\n') + '\n\n';
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

describe('Session usage splits the prompt-cache buckets', () => {
  let db: Database;
  let manager: SessionManager;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-usage-cache-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_gateway', 'gateway-agent', '{}')`);
    manager = new SessionManager(db);

    const registry = new ModelRegistry();
    registry.register({
      name: 'default',
      provider: 'openai_compatible',
      api_key: 'test-key',
      base_url: GATEWAY_BASE_URL,
      is_default: true,
    });
    manager.setExecutor(new DefaultSessionExecutor({
      agents: [{ name: 'gateway-agent', model: GATEWAY_MODEL, system: 'p' }],
      modelRegistry: registry,
      sandboxProvider: new LocalSandboxProvider(tmpDir),
      strategy: new DefaultStrategy(),
      eventLogger: manager.getEventLogger(),
    }));

    vi.stubGlobal('fetch', async () => new Response(sseBody('hello'), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('records the uncached share as input and both cache buckets separately', async () => {
    const session = manager.create({ agent: 'agent_gateway' });
    await manager.sendEvent(session.id, {
      type: 'user.message',
      content: [{ type: 'text', text: 'hi' }],
    } as never);
    const usageEvent = await waitFor(
      () => manager.getEventLogger().getEvents(session.id).find((event) => event.type === 'session.usage'),
      'usage snapshot',
    );

    const snapshot = (usageEvent.metadata as { usage: Record<string, unknown> }).usage;
    expect(snapshot.input_tokens).toBe(UNCACHED_TOKENS);
    expect(snapshot.output_tokens).toBe(COMPLETION_TOKENS);
    expect(snapshot.cache_read_input_tokens).toBe(CACHED_TOKENS);
    expect(snapshot.cache_creation).toEqual({
      ephemeral_5m_input_tokens: CACHE_WRITE_TOKENS,
      ephemeral_1h_input_tokens: 0,
    });

    // The session aggregate agrees — only the uncached share is input.
    expect(manager.get(session.id)!.usage).toEqual({
      tokensIn: UNCACHED_TOKENS,
      tokensOut: COMPLETION_TOKENS,
      cacheReadTokens: CACHED_TOKENS,
      cacheWriteTokens: CACHE_WRITE_TOKENS,
    });

    // The span row carries the same buckets so spend is priced per bucket.
    const span = manager.getEventLogger().getEvents(session.id)
      .find((event) => event.type === 'span.model_request_end');
    expect(span?.tokensIn).toBe(UNCACHED_TOKENS);
    expect(span?.cacheReadTokens).toBe(CACHED_TOKENS);
    expect(span?.cacheWriteTokens).toBe(CACHE_WRITE_TOKENS);

    // And the wire projections — the event and the session envelope — agree.
    expect(toApiEvent(usageEvent).usage).toMatchObject({
      input_tokens: UNCACHED_TOKENS,
      output_tokens: COMPLETION_TOKENS,
      cache_read_input_tokens: CACHED_TOKENS,
      cache_creation: {
        ephemeral_5m_input_tokens: CACHE_WRITE_TOKENS,
        ephemeral_1h_input_tokens: 0,
      },
    });
    expect(toApiSession(manager.get(session.id)!).usage).toEqual({
      input_tokens: UNCACHED_TOKENS,
      output_tokens: COMPLETION_TOKENS,
      cache_read_input_tokens: CACHED_TOKENS,
      cache_creation: {
        ephemeral_5m_input_tokens: CACHE_WRITE_TOKENS,
        ephemeral_1h_input_tokens: 0,
      },
    });
  });
});
