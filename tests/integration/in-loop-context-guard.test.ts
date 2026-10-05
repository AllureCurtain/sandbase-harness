/**
 * In-loop context guard, end to end through the strategy.
 *
 * The durable compactor runs between turns; a single turn whose tool loop
 * keeps growing must still fit the provider's window on every request. With a
 * tiny resolved window and a tool that emits a large payload, the request
 * after the result must carry the placeholder — not the raw payload — and the
 * durable event log must keep the full output.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { LanguageModel } from 'ai';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { DefaultStrategy } from '@/strategy/default-strategy.js';
import { IN_LOOP_TRIM_PLACEHOLDER } from '@/strategy/in-loop-context.js';
import type { StrategyContext } from '@/types/strategy.js';

const USAGE = { inputTokens: { total: 3 }, outputTokens: { total: 2 } };
const TOOL_CALLS = { unified: 'tool-calls', raw: 'tool_calls' } as const;
const STOP = { unified: 'stop', raw: 'stop' } as const;
const BIG_OUTPUT = 'z'.repeat(40_000);

/**
 * First request answers with a tool call, the second with plain text. Every
 * prompt the model is asked to stream is recorded verbatim.
 */
function recordingModel(prompts: unknown[][]): LanguageModel {
  let streams = 0;
  return {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'guard-model',
    supportedUrls: {},
    async doGenerate() {
      return { content: [{ type: 'text', text: 'ok' }], finishReason: STOP, usage: USAGE, warnings: [] } as any;
    },
    async doStream(options: { prompt: unknown[] }) {
      prompts.push(options.prompt);
      streams += 1;
      const first = streams === 1;
      return {
        stream: new ReadableStream({
          start(controller) {
            if (first) {
              controller.enqueue({ type: 'tool-input-start', id: 'tc_1', toolName: 'big' });
              controller.enqueue({ type: 'tool-input-delta', id: 'tc_1', delta: '{}' });
              controller.enqueue({ type: 'tool-input-end', id: 'tc_1' });
              controller.enqueue({ type: 'tool-call', toolCallId: 'tc_1', toolName: 'big', input: '{}' });
            } else {
              controller.enqueue({ type: 'text-start', id: 'ts_1' });
              controller.enqueue({ type: 'text-delta', id: 'ts_1', delta: 'done' });
              controller.enqueue({ type: 'text-end', id: 'ts_1' });
            }
            controller.enqueue({ type: 'finish', finishReason: first ? TOOL_CALLS : STOP, usage: USAGE });
            controller.close();
          },
        }),
      } as any;
    },
  } as unknown as LanguageModel;
}

describe('in-loop context guard', () => {
  let db: Database;
  let manager: SessionManager;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-in-loop-context-'));
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

  function contextFor(sessionId: string, model: LanguageModel, contextWindowTokens?: number): StrategyContext {
    const session = manager.get(sessionId)!;
    return {
      session: { ...session, agentDefinition: { name: 'a', model: 'm', system: 'p' } },
      userEvent: { type: 'user.message', content: [{ type: 'text', text: 'hi' }] },
      systemPrompt: 'p',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      model,
      tools: {
        big: {
          description: 'big',
          parameters: { type: 'object', properties: {} },
          execute: async () => BIG_OUTPUT,
        },
      },
      sandbox: {} as any,
      eventLog: manager.getEventLogger(),
      broadcast: () => {},
      config: { contextWindowTokens },
    } as unknown as StrategyContext;
  }

  it('replaces the stale tool payload in the next request while the log keeps it', async () => {
    const prompts: unknown[][] = [];
    const session = manager.create({ agent: 'agent_a' });
    // 5k-token window: the 10k-token tool output alone crosses the 80% trigger.
    const context = contextFor(session.id, recordingModel(prompts), 5_000);
    for await (const _event of new DefaultStrategy().execute(context)) {
      // consumed only to drive the generator
    }

    expect(prompts.length).toBe(2);
    const second = JSON.stringify(prompts[1]);
    expect(second).toContain(IN_LOOP_TRIM_PLACEHOLDER);
    expect(second).not.toContain(BIG_OUTPUT.slice(0, 500));

    // The event log still holds the untrimmed tool result.
    const events = manager.getEventLogger().getEvents(session.id);
    const toolResult = events.find((event) => event.type === 'agent.tool_result');
    expect(JSON.stringify(toolResult)).toContain(BIG_OUTPUT.slice(0, 100));
  });

  it('leaves the request untouched when no window is configured', async () => {
    const prompts: unknown[][] = [];
    const session = manager.create({ agent: 'agent_a' });
    const context = contextFor(session.id, recordingModel(prompts));
    for await (const _event of new DefaultStrategy().execute(context)) {
      // consumed only to drive the generator
    }
    expect(JSON.stringify(prompts[1])).toContain(BIG_OUTPUT.slice(0, 500));
  });
});
