/**
 * P0 truthfulness check for the built-in loop (CMA gap 4.1.4):
 *
 * `agent.mcp_tool_use` / `agent.mcp_tool_result` must carry the MCP server
 * identity, otherwise two servers exposing the same tool name are
 * indistinguishable in the log.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { DefaultStrategy } from '@/strategy/default-strategy.js';
import { resolveMcpServerName } from '@/core/mcp/mcp-manager.js';
import { toApiEvent } from '@/api/standard.js';
import type { LanguageModel } from 'ai';
import type { StrategyContext } from '@/types/strategy.js';
import type { SessionEvent } from '@/types/session.js';

const USAGE = { inputTokens: { total: 3 }, outputTokens: { total: 2 } };
const STOP = { unified: 'stop', raw: 'stop' } as const;
const TOOL_CALLS = { unified: 'tool-calls', raw: 'tool_calls' } as const;

/**
 * First stream: one MCP tool call. Later streams: plain text, so the step loop
 * terminates with a `stop` finish reason.
 */
function mcpToolThenTextModel(): LanguageModel {
  let streams = 0;
  return {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'mcp-tool',
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

describe('MCP tool event identity', () => {
  let db: Database;
  let manager: SessionManager;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-mcp-identity-'));
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
      model: mcpToolThenTextModel(),
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

  it('resolves the declared server deterministically when names contain underscores', () => {
    expect(resolveMcpServerName('mcp_mock_echo', ['mock'])).toBe('mock');
    // Both segments may contain underscores; the longest declared match wins.
    expect(resolveMcpServerName('mcp_mock_extra_echo', ['mock', 'mock_extra'])).toBe('mock_extra');
    // Nothing declared matches: no identity rather than a guess.
    expect(resolveMcpServerName('mcp_other_echo', ['mock'])).toBeUndefined();
    expect(resolveMcpServerName('write_file', ['mock'])).toBeUndefined();
  });
});
