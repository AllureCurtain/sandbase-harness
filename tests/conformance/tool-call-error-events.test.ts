import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { startRuntimeHarness } from './support/runtime-server.js';
import { startStubModelServer } from './support/stub-model-server.js';

describe('tool call error events', () => {
  it('pairs a schema-invalid tool call with an is_error agent.tool_result', async () => {
    // The stub's first reply issues a `write` call whose arguments do not
    // satisfy the tool schema. The SDK marks the call invalid and feeds a
    // tool-error part back to the model; that part is not in step.toolResults,
    // so the event log used to hold an orphan agent.tool_use.
    const stub = await startStubModelServer({
      toolCalls: [{ name: 'write', arguments: { not_a_path: true } }],
    });
    const runtime = await startRuntimeHarness({ modelBaseUrl: stub.baseUrl });
    try {
      const client = new Anthropic({ baseURL: runtime.baseUrl, apiKey: 'conformance-client-key', maxRetries: 0 });
      const agents = await client.beta.agents.list();
      const environments = await client.beta.environments.list();
      const session = await client.beta.sessions.create({
        agent: agents.data[0]!.id,
        environment_id: environments.data[0]!.id,
        initial_events: [{ type: 'user.message', content: [{ type: 'text', text: 'Write a file.' }] }],
      });

      await vi.waitFor(async () => {
        const events = await client.beta.sessions.events.list(session.id);
        const idle = events.data.filter((event) => event.type === 'session.status_idle').at(-1);
        expect(idle && 'stop_reason' in idle && idle.stop_reason?.type).toBe('end_turn');
      }, { timeout: 60_000, interval: 250 });

      const log = (await client.beta.sessions.events.list(session.id)).data;
      const uses = log.filter((event) => event.type === 'agent.tool_use');
      const results = log.filter((event) => event.type === 'agent.tool_result');
      expect(uses.length).toBeGreaterThan(0);

      // Every persisted tool_use pairs with a result event — the pairing
      // invariant callers rely on.
      const resultIds = new Set(
        results.map((event) => {
          const block = (event as { content?: Array<{ tool_use_id?: string }> }).content?.[0];
          return block?.tool_use_id;
        }),
      );
      for (const use of uses) {
        const useId = (use as { content?: Array<{ id?: string }> }).content?.[0]?.id;
        expect(resultIds.has(useId)).toBe(true);
      }

      // The invalid call's paired result carries the error flag.
      const errored = results.filter((event) => {
        const block = (event as { content?: Array<{ is_error?: boolean }> }).content?.[0];
        return block?.is_error === true;
      });
      expect(errored).toHaveLength(1);
    } finally {
      await runtime.stop();
      await stub.close();
    }
  }, 120_000);

  it('flags a failed tool execution as is_error with the same error text', async () => {
    // The stub asks `read` for a file that cannot exist. The tool answers an
    // `Error: ...` string — a failure, not a refusal — so the paired
    // tool_result must carry is_error on both the content block and the event
    // projection while the text stays what the model read.
    const stub = await startStubModelServer({
      toolCalls: [{ name: 'read', arguments: { path: '__definitely_missing__.txt' } }],
    });
    const runtime = await startRuntimeHarness({
      modelBaseUrl: stub.baseUrl,
      agentTools: [
        '  - type: agent_toolset_20260401',
        '    default_config:',
        '      enabled: false',
        '    configs:',
        '      - name: read',
        '        enabled: true',
      ],
    });
    try {
      const client = new Anthropic({ baseURL: runtime.baseUrl, apiKey: 'conformance-client-key', maxRetries: 0 });
      const agents = await client.beta.agents.list();
      const environments = await client.beta.environments.list();
      const session = await client.beta.sessions.create({
        agent: agents.data[0]!.id,
        environment_id: environments.data[0]!.id,
        initial_events: [{ type: 'user.message', content: [{ type: 'text', text: 'Run the command.' }] }],
      });

      await vi.waitFor(async () => {
        const events = await client.beta.sessions.events.list(session.id);
        const idle = events.data.filter((event) => event.type === 'session.status_idle').at(-1);
        expect(idle && 'stop_reason' in idle && idle.stop_reason?.type).toBe('end_turn');
      }, { timeout: 60_000, interval: 250 });

      const log = (await client.beta.sessions.events.list(session.id)).data;
      const readUse = log
        .filter((event) => event.type === 'agent.tool_use')
        .find((event) => (event as { content?: Array<{ name?: string }> }).content?.[0]?.name === 'read');
      expect(readUse).toBeDefined();
      const useId = (readUse as { content?: Array<{ id?: string }> }).content?.[0]?.id;

      const result = log
        .filter((event) => event.type === 'agent.tool_result')
        .find((event) => (event as { content?: Array<{ tool_use_id?: string }> }).content?.[0]?.tool_use_id === useId);
      expect(result).toBeDefined();
      const block = (result as { content?: Array<{ content?: string; is_error?: boolean }> }).content?.[0];
      expect(block?.content).toContain('Error:');
      expect(block?.content).toContain('__definitely_missing__');
      expect(block?.is_error).toBe(true);
    } finally {
      await runtime.stop();
      await stub.close();
    }
  }, 120_000);
});
