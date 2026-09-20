/**
 * P0 truthfulness check for the built-in loop (CMA gap 4.1.3):
 *
 * `agent.thinking` is a progress signal. CMA defines it as a thinking-started
 * signal, not as a carrier for reasoning content, so the raw
 * `step.reasoningText` must not reach the public event log.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { DefaultStrategy } from '@/strategy/default-strategy.js';
import type { LanguageModel } from 'ai';
import type { StrategyContext } from '@/types/strategy.js';
import type { SessionEvent } from '@/types/session.js';

const USAGE = { inputTokens: { total: 3 }, outputTokens: { total: 2 } };
const STOP = { unified: 'stop', raw: 'stop' } as const;

const REASONING_MARKER = 'PRIVATE-CHAIN-OF-THOUGHT-MARKER';

/**
 * First stream: reasoning only. Later streams: plain text, so the step loop
 * terminates with a `stop` finish reason.
 */
function reasoningThenTextModel(): LanguageModel {
  let streams = 0;
  return {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'reasoning-only',
    supportedUrls: {},
    async doGenerate() {
      return { content: [{ type: 'text', text: 'ok' }], finishReason: STOP, usage: USAGE, warnings: [] } as any;
    },
    async doStream() {
      streams += 1;
      const first = streams === 1;
      return {
        stream: new ReadableStream({
          start(controller) {
            if (first) {
              controller.enqueue({ type: 'reasoning-start', id: 'rs_1' });
              controller.enqueue({ type: 'reasoning-delta', id: 'rs_1', delta: REASONING_MARKER });
              controller.enqueue({ type: 'reasoning-end', id: 'rs_1' });
            } else {
              controller.enqueue({ type: 'text-start', id: 'ts_1' });
              controller.enqueue({ type: 'text-delta', id: 'ts_1', delta: 'done' });
              controller.enqueue({ type: 'text-end', id: 'ts_1' });
            }
            controller.enqueue({ type: 'finish', finishReason: STOP, usage: USAGE });
            controller.close();
          },
        }),
      } as any;
    },
  } as unknown as LanguageModel;
}

describe('DefaultStrategy thinking progress signal', () => {
  let db: Database;
  let manager: SessionManager;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-thinking-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_a', 'a', '{}')`);
    manager = new SessionManager(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function runTurn(): Promise<SessionEvent[]> {
    const session = manager.create({ agent: 'agent_a' });
    const events: SessionEvent[] = [];
    const context = {
      session: {
        ...session,
        agentDefinition: { name: 'a', model: 'm', system: 'p' },
      },
      userEvent: { type: 'user.message', content: [{ type: 'text', text: 'hi' }] },
      systemPrompt: 'p',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      model: reasoningThenTextModel(),
      tools: {},
      sandbox: {} as any,
      eventLog: manager.getEventLogger(),
      broadcast: (event: SessionEvent) => events.push(event),
      config: {},
    } as unknown as StrategyContext;

    for await (const event of new DefaultStrategy().execute(context)) {
      events.push(event);
    }
    return manager.getEventLogger().getEvents(session.id);
  }

  it('emits agent.thinking as a content-free progress signal', async () => {
    const events = await runTurn();
    const thinking = events.filter((event) => event.type === 'agent.thinking');

    // The reasoning branch ran: the mock model produced reasoning text.
    expect(thinking).toHaveLength(1);
    expect(thinking[0].content ?? []).toEqual([]);
    expect(thinking[0].metadata).toEqual({ signal: 'reasoning' });

    // The raw reasoning text is nowhere in the durable log.
    expect(JSON.stringify(events)).not.toContain(REASONING_MARKER);
  });
});
