/**
 * P0 truthfulness checks for the built-in loop (CMA gap §4.1.3 / §4.1.4):
 *
 * - `agent.thinking` is a progress signal. CMA defines it as "thinking started",
 *   not as a carrier for reasoning content, so the raw `step.reasoningText` must
 *   not reach the public event log.
 * - `agent.mcp_tool_use` / `agent.mcp_tool_result` must carry the MCP server
 *   identity, otherwise two servers exposing the same tool name are
 *   indistinguishable in the log.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { DefaultStrategy } from '@/strategy/default-strategy.js';
import { toApiEvent } from '@/api/standard.js';
import type { LanguageModel } from 'ai';
import type { StrategyContext } from '@/types/strategy.js';
import type { SessionEvent } from '@/types/session.js';

const USAGE = { inputTokens: { total: 3 }, outputTokens: { total: 2 } };
const STOP = { unified: 'stop', raw: 'stop' } as const;
const TOOL_CALLS = { unified: 'tool-calls', raw: 'tool_calls' } as const;

const REASONING_MARKER = 'PRIVATE-CHAIN-OF-THOUGHT-MARKER';

/**
 * First stream: reasoning + one MCP tool call. Later streams: plain text, so the
 * step loop terminates with a `stop` finish reason.
 */
function reasoningThenToolModel(): LanguageModel {
  let streams = 0;
  return {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'reasoning-tool',
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
              // Raw argument bytes arrive as the tool-input lifecycle first; the
              // SDK only treats the call as complete (and executes it) once the
              // `tool-call` part follows.
              controller.enqueue({ type: 'tool-input-start', id: 'tc_1', toolName: 'mcp_mock_echo' });
              controller.enqueue({ type: 'tool-input-delta', id: 'tc_1', delta: '{"text":"hi"}' });
              controller.enqueue({ type: 'tool-input-end', id: 'tc_1' });
              controller.enqueue({
                type: 'tool-call',
                toolCallId: 'tc_1',
                toolName: 'mcp_mock_echo',
                input: '{"text":"hi"}',
              });
              controller.enqueue({ type: 'finish', finishReason: TOOL_CALLS, usage: USAGE });
            } else {
              controller.enqueue({ type: 'text-start', id: 'ts_1' });
              controller.enqueue({ type: 'text-delta', id: 'ts_1', delta: 'done' });
              controller.enqueue({ type: 'text-end', id: 'ts_1' });
              controller.enqueue({ type: 'finish', finishReason: STOP, usage: USAGE });
            }
            controller.close();
          },
        }),
      } as any;
    },
  } as unknown as LanguageModel;
}

describe('DefaultStrategy thinking progress signal and MCP event identity', () => {
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
        agentDefinition: {
          name: 'a',
          model: 'm',
          system: 'p',
          mcp_servers: [{ name: 'mock', type: 'stdio', command: 'node', args: [] }],
        },
      },
      userEvent: { type: 'user.message', content: [{ type: 'text', text: 'hi' }] },
      systemPrompt: 'p',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      model: reasoningThenToolModel(),
      tools: {
        mcp_mock_echo: {
          description: 'echo',
          parameters: { type: 'object', properties: {} },
          execute: async () => 'echoed',
        },
      },
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

  it('attributes mcp tool events to the server that produced them', async () => {
    const events = await runTurn();
    const use = events.find((event) => event.type === 'agent.mcp_tool_use');
    const result = events.find((event) => event.type === 'agent.mcp_tool_result');

    expect(use).toBeDefined();
    expect(result).toBeDefined();
    expect(use!.metadata).toMatchObject({ mcp_server_name: 'mock' });
    expect(result!.metadata).toMatchObject({ mcp_server_name: 'mock' });

    // The wire projection exposes the identity as first-class fields.
    expect(toApiEvent(use!)).toMatchObject({ mcp_server_name: 'mock' });
    expect(toApiEvent(use!).mcp_tool_use_id).toBeUndefined();
    expect(toApiEvent(result!)).toMatchObject({
      mcp_server_name: 'mock',
      mcp_tool_use_id: 'tc_1',
    });
  });

  it('does not fabricate a server identity for non-MCP tools', async () => {
    const events = await runTurn();
    const plainUse = events.find((event) => event.type === 'agent.tool_use');
    expect(plainUse).toBeUndefined();
    expect(toApiEvent({ ...events[0], type: 'agent.tool_use', metadata: {} }).mcp_server_name).toBeUndefined();
  });
});
