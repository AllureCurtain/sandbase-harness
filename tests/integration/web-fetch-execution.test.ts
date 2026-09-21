import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { LanguageModel } from 'ai';
import { Database } from '@/core/db/database.js';
import { DefaultSessionExecutor } from '@/core/session/executor.js';
import { InMemoryEventLog } from '@/core/session/in-memory-event-log.js';
import { LocalSandboxProvider } from '@/sandbox/local-provider.js';
import { ModelRegistry } from '@/model/registry.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { ToolResolver } from '@/core/session/tool-resolver.js';
import { DefaultStrategy } from '@/strategy/default-strategy.js';
import { runtimeCapabilityRegistry } from '@/core/capabilities/registry.js';
import type { StrategyContext } from '@/types/strategy.js';
import type { CredentialInjectionBundle } from '@/core/credentials/injection.js';
import type { AgentDefinition } from '@/types/agent.js';

/**
 * WebFetch through the real execution path: a session turn runs the model
 * loop, the loop calls `web_fetch`, and the fetched page text comes back as a
 * normal `agent.tool_result` event. A local HTTP server stands in for the web,
 * reachable through the constructor-level transport seam only.
 */

const USAGE = { inputTokens: { total: 1 }, outputTokens: { total: 1 } };
const TOOL_CALLS = { unified: 'tool-calls', raw: 'tool_calls' } as const;
const STOP = { unified: 'stop', raw: 'stop' } as const;

let server: Server;
let port = 0;
const requestPaths: string[] = [];
const DELEGATE_SECRET = 'sk-delegate-parent-vault-4f2a';

beforeAll(async () => {
  server = createServer((req, res) => {
    requestPaths.push(req.url ?? '/');
    if ((req.url ?? '').startsWith('/token')) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`the page echoes ${DELEGATE_SECRET} back`);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><head><title>Site Report</title></head><body><h1>Lighthouse report body</h1><p>beam visible from the harbor</p></body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server?.closeAllConnections?.();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

function scriptedWebModel(toolUrl: string): LanguageModel {
  let turn = 0;
  return {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'scripted-web',
    supportedUrls: {},
    async doGenerate() {
      throw new Error('not used');
    },
    async doStream() {
      turn += 1;
      return {
        stream: new ReadableStream({
          start(controller) {
            if (turn === 1) {
              const args = JSON.stringify({ url: toolUrl });
              controller.enqueue({ type: 'tool-input-start', id: 'wf_1', toolName: 'web_fetch' });
              controller.enqueue({ type: 'tool-input-delta', id: 'wf_1', delta: args });
              controller.enqueue({ type: 'tool-input-end', id: 'wf_1' });
              controller.enqueue({ type: 'tool-call', toolCallId: 'wf_1', toolName: 'web_fetch', input: args });
              controller.enqueue({ type: 'finish', finishReason: TOOL_CALLS, usage: USAGE });
            } else {
              controller.enqueue({ type: 'text-start', id: 'text_1' });
              controller.enqueue({ type: 'text-delta', id: 'text_1', delta: 'The page mentions a lighthouse report.' });
              controller.enqueue({ type: 'text-end', id: 'text_1' });
              controller.enqueue({ type: 'finish', finishReason: STOP, usage: USAGE });
            }
            controller.close();
          },
        }),
      } as any;
    },
  } as unknown as LanguageModel;
}

function idleModel(): LanguageModel {
  return {
    specificationVersion: 'v4',
    provider: 'test',
    modelId: 'idle',
    supportedUrls: {},
    async doGenerate() {
      return { content: [], finishReason: STOP, usage: USAGE, warnings: [] } as any;
    },
    async doStream() {
      throw new Error('unused');
    },
  } as unknown as LanguageModel;
}

const webFetchOverrides = {
  lookupAddresses: async () => ['127.0.0.1'],
  isAddressAllowed: () => true,
};

function agentWith(configs: Array<Record<string, unknown>>): AgentDefinition {
  return {
    name: 'web-exec-agent',
    model: 'scripted',
    system: 'Fetch the page when asked.',
    tools: [{ type: 'agent_toolset_20260401', configs }],
  } as unknown as AgentDefinition;
}

interface Harness {
  db: Database;
  manager: SessionManager;
  workspace: string;
}

/** Ends the post-confirmation model turn without touching the stream. */
class NoopStrategy {
  readonly name = 'noop';
  // eslint-disable-next-line require-yield, @typescript-eslint/no-explicit-any
  async *execute(_ctx: any): AsyncIterable<never> {
    return;
  }
}

function createHarness(
  agent: AgentDefinition,
  model: LanguageModel,
  strategy?: { name: string; execute(ctx: never): AsyncIterable<never> },
): Harness {
  const workspace = mkdtempSync(join(tmpdir(), 'ma-webfetch-'));
  const db = new Database(join(workspace, 'test.db'));
  db.runMigrations();
  db.exec("INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')");
  db.prepare('INSERT INTO agents (id, name, definition) VALUES (?, ?, ?)').run(
    'agent_web',
    agent.name,
    JSON.stringify(agent),
  );

  const manager = new SessionManager(db);
  const registry = new ModelRegistry();
  registry.register({ name: 'scripted', provider: 'openai', model: 'scripted', is_default: true });
  (registry as any).createModel = () => model;
  const executor = new DefaultSessionExecutor({
    agents: [agent],
    modelRegistry: registry,
    sandboxProvider: new LocalSandboxProvider(workspace),
    strategy: (strategy ?? new DefaultStrategy()) as never,
    eventLogger: manager.getEventLogger(),
    webFetch: webFetchOverrides,
  });
  manager.setExecutor(executor);
  return { db, manager, workspace };
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function toolResultFor(manager: SessionManager, sessionId: string, toolUseId: string) {
  return manager
    .getEventLogger()
    .getEvents(sessionId)
    .find((event) => event.type === 'agent.tool_result'
      && (event.content?.[0] as { tool_use_id?: string } | undefined)?.tool_use_id === toolUseId);
}

describe('WebFetch through the agent/tool loop', () => {
  const harnesses: Harness[] = [];

  afterEach(async () => {
    for (const harness of harnesses.splice(0)) {
      await harness.manager.shutdown();
      harness.db.close();
      rmSync(harness.workspace, { recursive: true, force: true });
    }
  });

  it('returns the fetched page text to the model loop as an agent.tool_result', async () => {
    const agent = agentWith([{ name: 'web_fetch', allowed_domains: ['webfetch.test'] }]);
    const harness = createHarness(agent, scriptedWebModel(`http://webfetch.test:${port}/report`));
    harnesses.push(harness);
    requestPaths.length = 0;

    const session = harness.manager.create({ agent: 'agent_web' });
    await harness.manager.sendEvent(session.id, {
      type: 'user.message',
      content: [{ type: 'text', text: 'Fetch the report page.' }],
    } as never);

    await waitFor(() => harness.manager.get(session.id)?.status === 'paused', 'the web turn to finish');
    const events = harness.manager.getEventLogger().getEvents(session.id);
    expect(events.some((event) => event.type === 'session.error')).toBe(false);

    const toolUse = events.find((event) => event.type === 'agent.tool_use');
    expect(toolUse).toBeDefined();
    const block = toolUse!.content?.[0] as { name: string; input: Record<string, unknown> };
    expect(block.name).toBe('web_fetch');
    expect(block.input.url).toBe(`http://webfetch.test:${port}/report`);

    const toolResult = toolResultFor(harness.manager, session.id, 'wf_1');
    expect(toolResult).toBeDefined();
    const result = toolResult!.content![0] as { type: string; content: string; tool_use_id: string };
    expect(result.type).toBe('tool_result');
    expect(result.tool_use_id).toBe('wf_1');
    expect(result.content).toContain('Status: 200');
    expect(result.content).toContain('Lighthouse report body');
    expect(result.content).toContain('Title: Site Report');

    expect(events.some((event) => event.type === 'agent.message'
      && JSON.stringify(event.content).includes('lighthouse report'))).toBe(true);
    // The domain policy named `webfetch.test`; the seam is what resolved it to
    // the test server, so the guard saw the policy host, not a raw IP.
    expect(requestPaths.length).toBeGreaterThan(0);
  });

  it('reports a policy refusal as a tool error and still completes the turn', async () => {
    const agent = agentWith([{ name: 'web_fetch', allowed_domains: ['other.test'] }]);
    const harness = createHarness(agent, scriptedWebModel(`http://webfetch.test:${port}/report`));
    harnesses.push(harness);
    requestPaths.length = 0;

    const session = harness.manager.create({ agent: 'agent_web' });
    await harness.manager.sendEvent(session.id, {
      type: 'user.message',
      content: [{ type: 'text', text: 'Fetch it.' }],
    } as never);

    await waitFor(() => harness.manager.get(session.id)?.status === 'paused', 'the refused turn to finish');
    const toolResult = toolResultFor(harness.manager, session.id, 'wf_1');
    expect(toolResult).toBeDefined();
    expect((toolResult!.content![0] as { content: string }).content)
      .toContain('is not covered by the agent\'s allowed_domains');
    expect(requestPaths).toHaveLength(0);
  });

  it('holds an always_ask web_fetch for confirmation and never contacts the site first', async () => {
    const agent = agentWith([{
      name: 'web_fetch',
      allowed_domains: ['webfetch.test'],
      permission_policy: { type: 'always_ask' },
    }]);
    const harness = createHarness(agent, idleModel(), new NoopStrategy());
    harnesses.push(harness);
    requestPaths.length = 0;

    const session = harness.manager.create({ agent: 'agent_web' });
    harness.db.prepare("UPDATE sessions SET status='requires_action' WHERE id=?").run(session.id);
    harness.manager.getEventLogger().append(session.id, {
      type: 'agent.tool_use',
      content: [{
        type: 'tool_use',
        id: 'wf_pending',
        name: 'web_fetch',
        input: { url: `http://webfetch.test:${port}/report` },
        requires_confirmation: true,
        confirmation_group_id: 'confirm_web',
      }],
      metadata: { confirmation_group_id: 'confirm_web' },
    });

    await harness.manager.sendEvent(session.id, {
      type: 'user.tool_confirmation',
      tool_use_id: 'wf_pending',
      result: 'allow',
    } as never);

    await waitFor(
      () => toolResultFor(harness.manager, session.id, 'wf_pending') !== undefined,
      'the confirmed web_fetch result',
    );
    const content = (toolResultFor(harness.manager, session.id, 'wf_pending')!.content![0] as { content: string; is_error?: boolean });
    expect(content.is_error).toBeFalsy();
    expect(content.content).toContain('Lighthouse report body');
    expect(requestPaths).toEqual([`/report`]);
  });

  it('denies a pending web_fetch without any network contact', async () => {
    const agent = agentWith([{
      name: 'web_fetch',
      allowed_domains: ['webfetch.test'],
      permission_policy: { type: 'always_ask' },
    }]);
    const harness = createHarness(agent, idleModel(), new NoopStrategy());
    harnesses.push(harness);
    requestPaths.length = 0;

    const session = harness.manager.create({ agent: 'agent_web' });
    harness.db.prepare("UPDATE sessions SET status='requires_action' WHERE id=?").run(session.id);
    harness.manager.getEventLogger().append(session.id, {
      type: 'agent.tool_use',
      content: [{
        type: 'tool_use',
        id: 'wf_deny',
        name: 'web_fetch',
        input: { url: `http://webfetch.test:${port}/report` },
        requires_confirmation: true,
        confirmation_group_id: 'confirm_web_deny',
      }],
      metadata: { confirmation_group_id: 'confirm_web_deny' },
    });

    await harness.manager.sendEvent(session.id, {
      type: 'user.tool_confirmation',
      tool_use_id: 'wf_deny',
      result: 'deny',
      deny_message: 'not from this network',
    } as never);

    await waitFor(
      () => toolResultFor(harness.manager, session.id, 'wf_deny') !== undefined,
      'the denied web_fetch result',
    );
    const content = toolResultFor(harness.manager, session.id, 'wf_deny')!.content![0] as { content: string; is_error?: boolean };
    expect(content.is_error).toBe(true);
    expect(content.content).toContain('not from this network');
    expect(requestPaths).toHaveLength(0);
  });
});
describe('capability inventory matches the resolved executor', () => {
  function resolveNames(agent: AgentDefinition): Record<string, { execute?: unknown }> {
    const resolver = new ToolResolver({
      delegationService: {} as never,
      webFetch: webFetchOverrides,
    });
    // Main+'+s buildSandboxTools takes (agent, sandbox); the credential/redactor pair is
    // part of the credential-execution behaviour and is not on main yet.
    return resolver.buildSandboxTools(agent, {} as never);
  }

  it('registers an executable web_fetch exactly when the inventory says available', () => {
    const fetchStatus = runtimeCapabilityRegistry
      .list()
      .find((capability) => capability.id === 'web_fetch');
    expect(fetchStatus?.status).toBe('available');

    const tools = resolveNames(agentWith([{ name: 'web_fetch' }]));
    expect(typeof tools.web_fetch?.execute).toBe('function');
  });

  it('never registers web_search, which the inventory reports unavailable', () => {
    const searchStatus = runtimeCapabilityRegistry
      .list()
      .find((capability) => capability.id === 'web_search');
    expect(searchStatus?.status).toBe('unavailable');

    const agent = agentWith([{ name: 'web_search' }]);
    expect(runtimeCapabilityRegistry.getUnavailableCapabilities(agent).map((c) => c.id)).toEqual(['web_search']);
    const tools = resolveNames(agent);
    expect(tools.web_search).toBeUndefined();
  });

  it('drops web_fetch entirely when the policy is never_allow', () => {
    const tools = resolveNames(agentWith([{
      name: 'web_fetch',
      permission_policy: { type: 'never_allow' },
    }]));
    expect(tools.web_fetch).toBeUndefined();
  });
});

/**
 * A delegated child does not inherit the parent's credential bundle — its
 * tools run with an empty environment — but its results must still be
 * screened through the parent turn's redactor. A page that echoes a vault
 * token back used to reach the thread store and the parent's answer
 * unredacted because the delegation path built its tools without a redactor.
 */
class DelegationProbeStrategy {
  readonly name = 'delegation-probe';
  builtTools: Record<string, any> = {};
  childSawInjectedEnv = 'unset';
  delegateAnswer: string | undefined;

  // eslint-disable-next-line require-yield
  async *execute(ctx: StrategyContext): AsyncIterable<never> {
    if (ctx.session.id.startsWith('subsess_')) {
      const bash = ctx.tools.bash as { execute?: (input: { command: string }) => Promise<string> } | undefined;
      if (bash?.execute) {
        this.childSawInjectedEnv = (await bash.execute({ command: 'echo "env=${VAULT_TOKEN}"' })).trim();
      }
      const webFetch = ctx.tools.web_fetch as { execute: (input: { url: string }) => Promise<string> };
      const out = await webFetch.execute({ url: `http://webfetch.test:${port}/token` });
      const event = ctx.eventLog.append(ctx.session.id, {
        type: 'agent.message',
        content: [{ type: 'text', text: out }],
      });
      ctx.broadcast(event);
      return;
    }
    this.builtTools = ctx.tools;
    // The delegation runs inside the parent turn, while the turn's credential
    // redactor is still live — the same window the model loop uses.
    const delegate = ctx.tools['delegate_to_web-child'] as { execute: (input: { task: string }) => Promise<string> };
    this.delegateAnswer = await delegate.execute({ task: 'fetch the token page' });
    const event = ctx.eventLog.append(ctx.session.id, {
      type: 'agent.message',
      content: [{ type: 'text', text: 'parent turn done' }],
    });
    ctx.broadcast(event);
  }
}
