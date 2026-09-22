import { nanoid } from 'nanoid';
import type { AgentDefinition } from '@/types/agent.js';
import type { SandboxInstance } from '@/types/sandbox.js';
import type { Session, SessionLoopEngine } from '@/types/session.js';
import type { UserEvent } from '@/types/cma-protocol.js';
import type { AgentStrategy, StrategyContext } from '@/types/strategy.js';
import { ModelRegistry } from '@/model/registry.js';
import { InMemoryEventLog } from './in-memory-event-log.js';
import {
  assertPiAgentCanExecute,
} from '@/core/session/pi-policy.js';
import {
  validateDelegation,
  childDelegationContext,
  DelegationError,
  type DelegationContext,
} from '@/core/orchestrator/agent-orchestrator.js';

export interface DelegationServiceDeps {
  agents: AgentDefinition[];
  modelRegistry: ModelRegistry;
  strategy: AgentStrategy;
  /** Resolve the parent's frozen engine for delegated turns as well. */
  resolveStrategy?: (loopEngine: SessionLoopEngine) => AgentStrategy;
  /**
   * Provision a sandbox for a sub-agent run.
   *
   * Takes the parent session so the sub-agent lands on the same backend the
   * parent resolved to. A sub-agent executing shell commands is not a weaker
   * operation than the parent doing it, so it must not get a weaker sandbox:
   * previously this hardcoded the local provider, which meant a session
   * configured for Docker or Kubernetes still ran delegated commands directly
   * on the runtime host.
   */
  provisionSandbox: (session: Session, sandboxId: string) => Promise<SandboxInstance>;
  composeSystemPrompt: (agent: AgentDefinition) => string;
  buildMemoryContext?: (session: Session, agent: AgentDefinition, event: UserEvent) => Promise<string>;
  buildSandboxTools: (agent: AgentDefinition, sandbox: SandboxInstance, session?: Session) => Record<string, any>;
  resolveSkillDirs?: (agent: AgentDefinition) => string[];}

export class DelegationService {
  constructor(private readonly deps: DelegationServiceDeps) {}

  buildDelegationTools(
    agent: AgentDefinition,
    ctx: DelegationContext,
    session: Session,
  ): Record<string, any> {
    const tools: Record<string, any> = {};
    const loadedNames = this.deps.agents.map((loaded) => loaded.name);
    const allowed = agent.delegations ?? [];

    for (const target of allowed) {
      tools[`delegate_to_${target}`] = {
        description: `Delegate a self-contained task to the "${target}" agent and get its result.`,
        parameters: {
          type: 'object',
          properties: {
            task: { type: 'string', description: `Task/question for the ${target} agent` },
          },
          required: ['task'],
        },
        execute: async ({ task }: { task: string }) => {
          try {
            validateDelegation({
              fromAgent: agent.name,
              toAgent: target,
              chain: ctx.chain,
              depth: ctx.depth,
              maxDepth: ctx.maxDepth,
              allowedTargets: allowed,
              loadedAgentNames: loadedNames,
            });
            return await this.runSubAgent(target, task, childDelegationContext(ctx, target), session);
          } catch (err) {
            if (err instanceof DelegationError) return `Delegation error: ${err.message}`;
            return `Delegation failed: ${err instanceof Error ? err.message : String(err)}`;
          }
        },
      };
    }

    if (agent.enable_general_subagent) {
      tools['general_subagent'] = {
        description: 'Spawn a temporary sub-agent to handle a self-contained sub-task and return its result. The sub-agent cannot delegate further.',
        parameters: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'The sub-task to perform' },
          },
          required: ['task'],
        },
        execute: async ({ task }: { task: string }) => {
          if (ctx.depth >= ctx.maxDepth) {
            return `Delegation error: max depth (${ctx.maxDepth}) reached`;
          }
          try {
            const childAgent: AgentDefinition = {
              ...agent,
              delegations: [],
              enable_general_subagent: false,
            };
            return await this.runSubAgentWithDefinition(
              childAgent,
              task,
              childDelegationContext(ctx, `${agent.name}#sub`),
              session,
            );
          } catch (err) {
            return `Sub-agent failed: ${err instanceof Error ? err.message : String(err)}`;
          }
        },
      };
    }

    return tools;
  }

  private async runSubAgent(
    targetName: string,
    task: string,
    ctx: DelegationContext,
    session: Session,
  ): Promise<string> {
    const target = this.deps.agents.find((agent) => agent.name === targetName);
    if (!target) return `Delegation error: agent "${targetName}" not found`;
    return this.runSubAgentWithDefinition(target, task, ctx, session);
  }

  private async runSubAgentWithDefinition(
    target: AgentDefinition,
    task: string,
    ctx: DelegationContext,
    session: Session,
  ): Promise<string> {
    const strategy = this.deps.resolveStrategy?.(session.loopEngine ?? 'builtin') ?? this.deps.strategy;
    // A delegated target is a new Pi execution boundary. Validate its policy
    // before resolving credentials, constructing a model, or provisioning a
    // sandbox; otherwise a parent Pi session could bypass the creation-time
    // always_ask/never_allow/disabled admission gate for its child.
    if (session.loopEngine === 'pi' || strategy.name === 'pi') {
      assertPiAgentCanExecute(target);
    }
    // Pi owns its transport but still needs the selected concrete model config.
    // Builtin strategies keep their existing AI SDK model construction path and
    // do not need registry resolution before that factory runs.
    const modelConfig = strategy.requiresModel === false
      ? this.deps.modelRegistry.resolveModelConfig(target.model)
      : undefined;
    const model = strategy.requiresModel === false
      ? undefined
      : this.deps.modelRegistry.createModel(target.model);
    const subSessionId = `subsess_${ctx.chain.join('.')}_${nanoid(8)}`;
    const childSession: Session = {
      id: subSessionId,
      agentId: target.name,
      agentName: target.name,
      agentDefinition: target,
      loopEngine: session.loopEngine ?? 'builtin',
      environmentId: session.environmentId,
      resources: session.resources,
      contextId: session.contextId,
      status: 'running',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as Session;
    // Same backend as the parent session, resolved through the same fail-loud
    // path — a sub-agent must not receive weaker isolation than its parent.
    const sandbox = await this.deps.provisionSandbox(session, subSessionId);

    try {
      const tools = this.deps.buildSandboxTools(target, sandbox, childSession);
      Object.assign(tools, this.buildDelegationTools(target, ctx, session));

      const memLog = new InMemoryEventLog();
      const collected: string[] = [];

      const subContext: StrategyContext = {
        session: childSession,
        systemPrompt: this.deps.buildMemoryContext
          ? await this.deps.buildMemoryContext(childSession, target, { type: 'user.message', content: [{ type: 'text', text: task }] })
          : this.deps.composeSystemPrompt(target),
        userEvent: { type: 'user.message', content: [{ type: 'text', text: task }] },
        messages: [{ role: 'user', content: [{ type: 'text', text: task }] }] as any,
        modelConfig,
        model,
        skillDirs: this.deps.resolveSkillDirs?.(target) ?? [],
        tools,
        sandbox,
        eventLog: memLog,
        broadcast: (event) => {
          if (event.type === 'agent.message' && event.content) {
            const text = event.content
              .filter((block: any) => block.type === 'text')
              .map((block: any) => block.text)
              .join('\n');
            if (text) collected.push(text);
          }
        },
        config: {
          maxSteps: target.max_turns ?? 25,
          temperature: target.temperature ?? 0.7,
        },
      };

      for await (const _evt of strategy.execute(subContext)) {
        // sub-agent events are ephemeral
      }

      return collected.join('\n') || '(sub-agent produced no output)';
    } finally {
      await sandbox.cleanup().catch(() => {});
    }
  }
}
