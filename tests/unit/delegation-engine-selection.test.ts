import { describe, expect, it, vi } from 'vitest';
import { DelegationService } from '@/core/session/delegation-service.js';
import { assertPiAgentCanExecute } from '@/core/session/pi-policy.js';
import { ModelRegistry } from '@/model/registry.js';
import type { AgentDefinition } from '@/types/agent.js';
import type { SandboxInstance } from '@/types/sandbox.js';
import type { AgentStrategy } from '@/types/strategy.js';

const target: AgentDefinition = {
  name: 'child',
  model: 'test-model',
  system: 'Complete delegated work.',
};

const sandbox = {
  sessionId: 'subsession',
  execute: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
  writeFile: async () => {},
  readFile: async () => '',
  listFiles: async () => [],
  cleanup: async () => {},
} as SandboxInstance;

describe('delegated session engine selection', () => {
  it('keeps a persisted builtin parent on builtin after Pi becomes the global strategy', async () => {
    const calls: string[] = [];
    const builtin: AgentStrategy = {
      name: 'builtin',
      async *execute(context) {
        calls.push(`builtin:${context.session.loopEngine}`);
      },
    };
    const globalPi: AgentStrategy = {
      name: 'pi',
      async *execute() {
        calls.push('pi');
      },
    };
    const registry = new ModelRegistry();
    registry.register({
      name: 'default',
      provider: 'openai',
      model: 'test-model',
      api_key: 'test-key',
      is_default: true,
    });
    vi.spyOn(registry, 'createModel').mockImplementation(() => ({} as any));
    const service = new DelegationService({
      agents: [target],
      modelRegistry: registry,
      // Simulates a restart that selected Pi globally after this parent was created.
      strategy: globalPi,
      resolveStrategy: (engine) => engine === 'builtin' ? builtin : globalPi,
      provisionSandbox: async () => sandbox,
      composeSystemPrompt: () => 'delegated prompt',
      buildSandboxTools: () => ({}),
    });

    await (service as any).runSubAgentWithDefinition(target, 'do delegated work', {
      chain: ['parent'],
      depth: 0,
      maxDepth: 1,
    }, {
      id: 'sess_persisted_builtin',
      loopEngine: 'builtin',
      agentId: 'agent_parent',
      agentName: 'parent',
      environmentId: 'env_default',
      status: 'running',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(calls).toEqual(['builtin:builtin']);
  });

  it('passes the selected config to delegated Pi without constructing an AI SDK model', async () => {
    const captured: Array<{ model?: unknown; modelConfig?: unknown; engine?: string }> = [];
    const pi: AgentStrategy = {
      name: 'pi',
      requiresModel: false,
      async *execute(context) {
        captured.push({
          model: context.model,
          modelConfig: context.modelConfig,
          engine: context.session.loopEngine,
        });
      },
    };
    const registry = new ModelRegistry();
    registry.register({
      name: 'default',
      provider: 'openai',
      model: 'configured-default',
      api_key: 'pi-key',
      is_default: true,
    });
    const createModel = vi.spyOn(registry, 'createModel').mockImplementation(() => {
      throw new Error('Pi must not construct an AI SDK model');
    });
    const service = new DelegationService({
      agents: [target],
      modelRegistry: registry,
      strategy: pi,
      resolveStrategy: () => pi,
      provisionSandbox: async () => sandbox,
      composeSystemPrompt: () => 'delegated Pi prompt',
      buildSandboxTools: () => ({}),
    });

    await (service as any).runSubAgentWithDefinition(target, 'delegate to Pi', {
      chain: ['parent'],
      depth: 0,
      maxDepth: 1,
    }, {
      id: 'sess_persisted_pi',
      loopEngine: 'pi',
      agentId: 'agent_parent',
      agentName: 'parent',
      environmentId: 'env_default',
      status: 'running',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(createModel).not.toHaveBeenCalled();
    expect(captured).toEqual([{
      model: undefined,
      modelConfig: expect.objectContaining({
        provider: 'openai',
        model: 'test-model',
        api_key: 'pi-key',
      }),
      engine: 'pi',
    }]);
  });

  it('admits a delegated Pi target that declares always_ask and keeps its gate plan', async () => {
    const restrictedTarget: AgentDefinition = {
      ...target,
      name: 'restricted-child',
      tools: [{
        type: 'agent_toolset_20260401',
        configs: [{ name: 'bash', permission_policy: { type: 'always_ask' } }],
      }],
    };
    const delegated: AgentDefinition[] = [];
    const pi: AgentStrategy = {
      name: 'pi',
      requiresModel: false,
      async *execute(context) {
        delegated.push(context.session.agentDefinition as AgentDefinition);
      },
    };
    const registry = new ModelRegistry();
    registry.register({
      name: 'default',
      provider: 'openai',
      model: 'configured-default',
      api_key: 'pi-key',
      is_default: true,
    });
    const provisionSandbox = vi.fn(async () => sandbox);
    const service = new DelegationService({
      agents: [restrictedTarget],
      modelRegistry: registry,
      strategy: pi,
      resolveStrategy: () => pi,
      provisionSandbox,
      composeSystemPrompt: () => 'restricted prompt',
      buildSandboxTools: () => ({}),
    });

    await (service as any).runSubAgentWithDefinition(
      restrictedTarget,
      'delegate to restricted Pi',
      { chain: ['parent'], depth: 0, maxDepth: 1 },
      {
        id: 'sess_pi_parent',
        loopEngine: 'pi',
        agentId: 'agent_parent',
        agentName: 'parent',
        environmentId: 'env_default',
        status: 'running',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    );

    // Admission used to refuse this delegated target with
    // `pi_always_ask_not_supported` before the sandbox was provisioned. The
    // managed gate replaces the refusal: the delegation runs, and the gated tool
    // still compiles into the plan the child launch receives.
    expect(provisionSandbox).toHaveBeenCalled();
    expect(delegated).toHaveLength(1);
    expect(assertPiAgentCanExecute(delegated[0]).gate).toEqual(['bash']);
  });
});
