/**
 * Integration: coordinator `send_to_agent` over the real executor — PR 3.3.
 *
 * `DefaultSessionExecutor` + `DefaultStrategy` drive a scripted `LanguageModel`:
 * the coordinator's first turn calls `send_to_agent`, the child's turn writes a
 * file (a `write` tool call) then answers "done", and the coordinator's re-entered
 * turn reads the reply and finishes. Asserts the §5 primary-stream order, the
 * file-visible shared workspace, and the `[来自 reviewer] done` text reaching the
 * coordinator's second model request.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { LanguageModel } from 'ai';
import { Database } from '@/core/db/database.js';
import { ModelRegistry } from '@/model/registry.js';
import { LocalSandboxProvider } from '@/sandbox/local-provider.js';
import { DefaultSessionExecutor } from '@/core/session/executor.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { DefaultStrategy } from '@/strategy/default-strategy.js';
import type { EnvironmentConfig } from '@/types/sandbox.js';
import type { AgentDefinition } from '@/types/agent.js';
import type { SessionEvent } from '@/types/session.js';

const USAGE = { inputTokens: { total: 1 }, outputTokens: { total: 1 } };
const TOOL_CALLS = { unified: 'tool-calls', raw: 'tool_calls' } as const;
const STOP = { unified: 'stop', raw: 'stop' } as const;

const WORKER: AgentDefinition = {
  name: 'reviewer',
  model: 'scripted',
  system: 'You are the reviewer child.',
  tools: [{ type: 'agent_toolset_20260401' }],
};
const COORDINATOR: AgentDefinition = {
  name: 'coordinator',
  model: 'scripted',
  system: 'You are the coordinator.',
  tools: [{ type: 'agent_toolset_20260401' }],
  multiagent: { type: 'coordinator', agents: [{ type: 'agent', id: 'agent_worker', version: 1 }] },
};

interface RecordedCall {
  system?: unknown;
  prompt: unknown[];
}

/**
 * A scripted model that answers by role. The coordinator's first request issues
 * a `send_to_agent` call; the child's first request writes the file, its second
 * (the tool-result follow-up) says "done"; the coordinator's second request —
 * which must now carry the `[来自 reviewer]` reply — finishes with text.
 *
 * The turn counters live in the `script` bag the test owns, not inside the
 * factory: the registry constructs a fresh `LanguageModel` per turn, so a
 * counter closed over inside the model would reset on every request.
 */
function coordinatorScript(calls: RecordedCall[], script: { coordinatorTurns: number; childTurns: number }): LanguageModel {
  const text = (controller: ReadableStreamDefaultController, body: string) => {
    controller.enqueue({ type: 'text-start', id: 't1' });
    controller.enqueue({ type: 'text-delta', id: 't1', delta: body });
    controller.enqueue({ type: 'text-end', id: 't1' });
    controller.enqueue({ type: 'finish', finishReason: STOP, usage: USAGE });
    controller.close();
  };
  const toolCall = (controller: ReadableStreamDefaultController, name: string, input: Record<string, unknown>, id = 'call_1') => {
    const args = JSON.stringify(input);
    controller.enqueue({ type: 'tool-input-start', id, toolName: name });
    controller.enqueue({ type: 'tool-input-delta', id, delta: args });
    controller.enqueue({ type: 'tool-input-end', id });
    controller.enqueue({ type: 'tool-call', toolCallId: id, toolName: name, input: args });
    controller.enqueue({ type: 'finish', finishReason: TOOL_CALLS, usage: USAGE });
    controller.close();
  };

  return {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'scripted',
    supportedUrls: {},
    async doGenerate() { throw new Error('not used'); },
    async doStream(options: { prompt?: Array<{ role?: string; content?: unknown }> } = {}) {
      const prompt = options.prompt ?? [];
      calls.push({ system: (options as { system?: unknown }).system, prompt });
      // The child's system prompt names it — `composeSystemPrompt` renders the
      // agent's `system` into the leading system message, whichever field the
      // provider SDK packs it into.
      const isChild = JSON.stringify(prompt).includes('reviewer child')
        || JSON.stringify((options as { system?: unknown }).system ?? '').includes('reviewer child');
      return {
        stream: new ReadableStream({
          start(controller) {
            if (isChild) {
              script.childTurns += 1;
              if (script.childTurns === 1) toolCall(controller, 'write', { path: 'review.md', content: 'review notes' });
              else text(controller, 'done');
            } else {
              script.coordinatorTurns += 1;
              if (script.coordinatorTurns === 1) toolCall(controller, 'send_to_agent', { agent: 'reviewer', message: 'review this' });
              else text(controller, 'coordinator final');
            }
          },
        }),
      } as any;
    },
  } as unknown as LanguageModel;
}

function waitFor(predicate: () => boolean, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error('timed out waiting for multi-agent turn'));
      setTimeout(poll, 15);
    };
    poll();
  });
}

const eventsOf = (manager: SessionManager, sessionId: string) => manager.getEventLogger().getEvents(sessionId);

describe('coordinator send_to_agent (real executor)', () => {
  let db: Database;
  let workspace: string;
  let manager: SessionManager;
  let executor: DefaultSessionExecutor;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'ma-coord-int-'));
    db = new Database(join(workspace, 'test.db'));
    db.runMigrations();
    db.exec("INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')");
    db.prepare("INSERT INTO agents (id, name, version, definition) VALUES ('agent_coordinator', 'coordinator', 1, ?)")
      .run(JSON.stringify(COORDINATOR));
    db.prepare("INSERT INTO agents (id, name, version, definition) VALUES ('agent_worker', 'reviewer', 1, ?)")
      .run(JSON.stringify(WORKER));
    manager = new SessionManager(db);
  });

  afterEach(async () => {
    await manager.shutdown();
    db.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  it('dispatches a child, shares the workspace, and returns the reply', async () => {
    const calls: RecordedCall[] = [];
    const script = { coordinatorTurns: 0, childTurns: 0 };
    const registry = new ModelRegistry();
    registry.register({ name: 'scripted', provider: 'openai', model: 'scripted', is_default: true });
    (registry as any).createModel = () => coordinatorScript(calls, script);
    executor = new DefaultSessionExecutor({
      agents: [COORDINATOR, WORKER],
      modelRegistry: registry,
      sandboxProvider: new LocalSandboxProvider(workspace),
      resolveEnvironmentConfig: () => ({ name: 'local', sandbox_provider: 'local' } as EnvironmentConfig),
      strategy: new DefaultStrategy(),
      eventLogger: manager.getEventLogger(),
    });
    manager.setExecutor(executor);

    const session = manager.create({ agent: 'agent_coordinator' });
    await manager.sendEvent(session.id, { type: 'user.message', content: [{ type: 'text', text: 'start' }] });

    await waitFor(() =>
      eventsOf(manager, session.id).some((e) => e.type === 'agent.thread_message_received')
        && manager.get(session.id)?.status === 'paused',
    );
    const threads = manager.getThreadStore().listBySession(session.id);
    const child = threads.find((t) => t.parentThreadId !== null)!;
    const primaryId = manager.getThreadStore().primaryThreadId(session.id);
    const events = eventsOf(manager, session.id);
    const prim = events.filter((e) => e.threadId === undefined || e.threadId === primaryId || e.crossPosted === true);
    const primTypes = prim.map((e) => e.type);

    // §5 primary-stream order.
    expect(primTypes).toContain('session.thread_created');
    expect(primTypes).toContain('agent.thread_message_sent');
    expect(primTypes.some((t, i) => t === 'session.thread_status_running' && prim[i]!.metadata?.session_thread_id === child.id)).toBe(true);
    expect(primTypes.some((t, i) => t === 'session.thread_status_idle' && prim[i]!.metadata?.session_thread_id === child.id)).toBe(true);
    expect(primTypes).toContain('agent.thread_message_received');
    expect(primTypes.indexOf('session.thread_created')).toBeLessThan(primTypes.indexOf('agent.thread_message_sent'));
    const childRunningIdx = prim.findIndex((e) => e.type === 'session.thread_status_running' && e.metadata?.session_thread_id === child.id);
    const childIdleIdx = prim.findIndex((e) => e.type === 'session.thread_status_idle' && e.metadata?.session_thread_id === child.id);
    const replyIdx = prim.findIndex((e) => e.type === 'agent.thread_message_received' && e.threadId === primaryId);
    expect(childRunningIdx).toBeLessThan(childIdleIdx);
    expect(childIdleIdx).toBeLessThan(replyIdx);

    // The child wrote review.md into the shared workspace — the same sandbox
    // the coordinator's tools would see (local provider's per-session workdir).
    const workDir = join(workspace, 'sandbox', session.id);
    expect(existsSync(join(workDir, 'review.md'))).toBe(true);
    expect(readFileSync(join(workDir, 'review.md'), 'utf8')).toBe('review notes');

    // The coordinator's second model request carried the reply as `[来自 reviewer] done`.
    // A coordinator call is identified by its own system prompt: the child's
    // names the reviewer, the coordinator's names itself — and 'reviewer child'
    // only appears inside the child's system.
    const coordinatorCalls = calls.filter((c) => JSON.stringify(c).includes('coordinator') && !JSON.stringify(c).includes('reviewer child'));
    expect(coordinatorCalls.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(coordinatorCalls.at(-1))).toContain('done');
    expect(JSON.stringify(coordinatorCalls.at(-1))).toContain('reviewer');

    // Two threads, child completed its turn.
    expect(threads).toHaveLength(2);
    expect(child.status).toBe('paused');
  }, 60_000);
});
