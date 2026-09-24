/**
 * Integration test: the declared top-level fields of tool events reach the wire.
 *
 * A tool event persists its payload inside `content[0]`, while
 * `src/types/cma-protocol.ts` declares `name` and `input` as top-level fields on
 * `agent.tool_use`, `agent.mcp_tool_use`, and `agent.custom_tool_use`, and
 * `tool_use_id` / `custom_tool_use_id` as top-level fields on the results. The
 * published client loop depends on that shape: it resolves a blocking event id
 * from `stop_reason.event_ids`, then reads `toolEvent.name` and
 * `toolEvent.input` off the event it found. Reading only `content` makes that
 * call impossible, so these assertions pin the projected fields, and pin that
 * the projection did not move, rename, or overwrite anything.
 *
 * The top-level `id` is asserted as the *event* id, not the tool-call id: it is
 * the value the same loop answers with, so a projection that copied the
 * tool-call id over it would break the addressing rather than improve it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { createServer } from '@/api/server.js';

describe('Tool event top-level fields', () => {
  let db: Database;
  let tmpDir: string;
  let app: ReturnType<typeof createServer>;
  let manager: SessionManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-tool-fields-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.prepare("INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')").run();
    db.prepare("INSERT INTO agents (id, name, definition) VALUES ('agent_x', 'x', '{}')").run();
    db.prepare("INSERT INTO sessions (id, agent_id, agent_name, environment_id) VALUES ('sess_a', 'agent_x', 'x', 'env_default')").run();
    manager = new SessionManager(db);
    app = createServer({
      db,
      sessionManager: manager,
      agents: [],
      reloadAgents: () => ({ agents: [], errors: [] }),
      consoleRoot: null,
    });
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Append one event through the real logger and read it back off the API. */
  async function project(event: Record<string, unknown>, type?: string) {
    manager.getEventLogger().append('sess_a', { type: type ?? event.type, ...event } as any);
    const res = await app.request('/v1/sessions/sess_a/events');
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const events = body.data ?? body.events ?? body;
    return events[events.length - 1];
  }

  const block = (overrides: Record<string, unknown> = {}) => ({
    type: 'tool_use',
    id: 'toolu_call_1',
    name: 'run_shell',
    input: { command: 'echo hi', timeout: 5 },
    ...overrides,
  });

  it('lifts name and input off an agent.tool_use block', async () => {
    const event = await project({ type: 'agent.tool_use', content: [block()] });

    expect(event.type).toBe('agent.tool_use');
    expect(event.name).toBe('run_shell');
    expect(event.input).toEqual({ command: 'echo hi', timeout: 5 });
    // The projection adds; it does not move.
    expect(event.content[0].name).toBe('run_shell');
    expect(event.content[0].input).toEqual({ command: 'echo hi', timeout: 5 });
    expect(event.content[0].id).toBe('toolu_call_1');
  });

  it('keeps the top-level id as the event id, not the tool-call id', async () => {
    const event = await project({ type: 'agent.tool_use', content: [block()] });

    // The published loop answers with this value, so it must address the event.
    expect(event.id).toMatch(/^sevt_/);
    expect(event.id).not.toBe('toolu_call_1');
  });

  it('lifts name and input off agent.mcp_tool_use alongside mcp_server_name', async () => {
    const event = await project({
      type: 'agent.mcp_tool_use',
      content: [block({ name: 'mcp_read_file', input: { path: '/tmp/x' } })],
      metadata: { mcp_server_name: 'filesystem' },
    });

    expect(event.name).toBe('mcp_read_file');
    expect(event.input).toEqual({ path: '/tmp/x' });
    expect(event.mcp_server_name).toBe('filesystem');
  });

  it('lifts name and input off agent.custom_tool_use', async () => {
    const event = await project({
      type: 'agent.custom_tool_use',
      content: [block({ name: 'get_weather', input: { city: 'Paris' } })],
      metadata: { custom_tool: true },
    });

    expect(event.name).toBe('get_weather');
    expect(event.input).toEqual({ city: 'Paris' });
    expect(event.content[0].name).toBe('get_weather');
  });

  it('lifts tool_use_id off an agent.tool_result block', async () => {
    const event = await project({
      type: 'agent.tool_result',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_call_1', content: 'hi' }],
    });

    expect(event.tool_use_id).toBe('toolu_call_1');
    expect(event.content[0].tool_use_id).toBe('toolu_call_1');
  });

  it('lifts mcp_tool_use_id off an agent.mcp_tool_result block', async () => {
    const event = await project({
      type: 'agent.mcp_tool_result',
      content: [{ type: 'tool_result', tool_use_id: 'mcp_call_9', content: 'ok' }],
      metadata: { mcp_server_name: 'filesystem' },
    });

    expect(event.mcp_tool_use_id).toBe('mcp_call_9');
  });

  it('carries custom_tool_use_id on a user.custom_tool_result', async () => {
    // Accepted through the real path, so the assertion covers the value the
    // runtime actually stored rather than one the test wrote into metadata.
    manager.getEventLogger().append('sess_a', {
      type: 'agent.custom_tool_use',
      content: [block({ id: 'toolu_custom_1', name: 'get_weather', input: { city: 'Paris' } })],
    } as any);
    const accepted = await app.request('/v1/sessions/sess_a/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        events: [{
          type: 'user.custom_tool_result',
          custom_tool_use_id: 'toolu_custom_1',
          content: [{ type: 'text', text: 'sunny' }],
        }],
      }),
    });
    expect(accepted.status).toBeLessThan(400);

    const res = await app.request('/v1/sessions/sess_a/events');
    const body = await res.json() as any;
    const events = body.data ?? body.events ?? body;
    const result = events.find((item: any) => item.type === 'user.custom_tool_result');

    expect(result.custom_tool_use_id).toBe('toolu_custom_1');
    expect(result.content[0].text).toBe('sunny');
  });

  it('does not leak a tool field onto an event whose type has none', async () => {
    const message = await project({
      type: 'agent.message',
      content: [{ type: 'text', text: 'hello' }],
    });
    expect(message).not.toHaveProperty('name');
    expect(message).not.toHaveProperty('input');
    expect(message).not.toHaveProperty('tool_use_id');

    // A tool_result block on an event type that is not a tool result must not
    // produce a top-level pairing field either.
    const confirmation = await project({
      type: 'user.tool_confirmation',
      metadata: { tool_use_id: 'toolu_call_1', result: 'allow' },
    });
    expect(confirmation.tool_use_id).toBe('toolu_call_1');
    expect(confirmation).not.toHaveProperty('name');
    expect(confirmation).not.toHaveProperty('input');
    expect(confirmation).not.toHaveProperty('custom_tool_use_id');
  });

  it('omits the fields rather than sending null when the block lacks them', async () => {
    const event = await project({
      type: 'agent.tool_use',
      content: [{ type: 'tool_use', id: 'toolu_bare' }],
    });

    // A field the runtime cannot read is absent, so a client never sees a
    // `null` it would have to interpret.
    expect(event).not.toHaveProperty('name');
    expect(event).not.toHaveProperty('input');
    expect(event.content[0].id).toBe('toolu_bare');
  });
});