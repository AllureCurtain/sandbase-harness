/**
 * Coordinator tools — the two tools a `multiagent` roster gives a thread.
 *
 * Only a thread whose agent definition carries `multiagent` holds these: the
 * coordinator's own primary thread and any `self` replica. A roster member's
 * thread does not, which is what enforces the one-level delegation limit at
 * runtime rather than only at write time.
 *
 * Both tools are local design (§4.4, D7/D8): the published contract names
 * `list_agents` and `send_to_agent` but fixes no parameter or result shape, so
 * the shapes here are the runtime's own and are marked `unverified` upstream.
 *
 * `send_to_agent` is asynchronous by contract (D8): it records the dispatch and
 * returns `{thread_id, status: 'sent'}` immediately, and the reply arrives back
 * on the coordinator thread as an `agent.thread_message_received` event that
 * drives the coordinator's next turn. A synchronous wait would freeze the
 * coordinator for the whole child turn, which is exactly what the "fan out
 * several tasks at once" pattern the roster exists for cannot tolerate.
 */

import type { AgentDefinition } from '@/types/agent.js';
import type { SessionThread } from './session-threads.js';
import { toolError } from '@/core/tool-result-error.js';

/** The concurrency cap a child thread consumes one slot of (§1.2). */
export const MAX_ACTIVE_CHILD_THREADS = 25;

/** A dispatchable subagent member: a concrete, version-pinned agent reference. */
export type CoordinatorMember = { type: 'agent'; id: string; version: number };

/** The caller-supplied shape of a thread-scoped inline agent. */
export interface InlineSubagentDefinition {
  name: string;
  description?: string;
  system?: string;
}

/**
 * Whether the current topology permits inline subagents. Inline dispatch is
 * unavailable on the legacy `coordinator` shape and when `subagents` or its
 * `inline_agents` setting is disabled.
 */
export function inlineSubagentsEnabled(agent: AgentDefinition): boolean {
  const multiagent = agent.multiagent;
  return multiagent?.type === 'multiagent_20261001'
    && multiagent.subagents.type === 'enabled'
    && multiagent.subagents.inline_agents.type === 'enabled';
}

/**
 * The subagents a thread with this definition may dispatch to.
 *
 * Both topologies expose the same dispatch surface: the legacy `coordinator`
 * roster's agent entries, or the current topology's `subagents.predefined_agents`
 * when that setting is enabled. Advisor entries are never dispatchable, and a
 * disabled `subagents` setting yields none. Inline agents are a later slice.
 */
export function subagentMembers(agent: AgentDefinition): CoordinatorMember[] {
  const multiagent = agent.multiagent;
  if (!multiagent) return [];
  if (multiagent.type === 'coordinator') {
    return multiagent.agents.filter(
      (member): member is CoordinatorMember => member.type === 'agent',
    );
  }
  if (multiagent.subagents.type === 'disabled') return [];
  return multiagent.subagents.predefined_agents;
}

/**
 * The slice of the session manager the coordinator tools need. Kept narrow and
 * injected rather than the manager itself: the tool layer names what it reads
 * and what it enqueues, and the runner supplies the real implementation — so a
 * tool error stays a tool error and never becomes a thrown control-plane
 * exception the model cannot read.
 */
export interface CoordinatorToolsHost {
  /** The session the coordinator thread runs in. */
  readonly sessionId: string;
  /** The coordinator thread these tools are bound to. */
  readonly parentThread: SessionThread;
  /** List the session's current threads (for `list_agents`). */
  listThreads(): SessionThread[];
  /** Count of non-archived, non-terminal child threads (the 25-slot budget). */
  activeChildCount(): number;
  /** Resolve a roster member's agent id to its durable display name. */
  agentNameFor(agentId: string): string | undefined;
  /** Resolve a roster member's agent id to its durable description. */
  agentDescriptionFor(agentId: string): string | undefined;
  /**
   * Dispatch a message to a roster member: create or reuse the target thread,
   * record the sent/received event pair on both streams, and enqueue the
   * child's turn on its own execution chain. Returns the resolved target row
   * plus whether a new thread row was created.
   */
  dispatchToAgent(input: {
    member: CoordinatorMember;
    message: string;
    /** An existing thread to send a follow-up into; omitted spawns a new one. */
    threadId?: string;
  }):
    | { ok: true; thread: SessionThread; created: boolean }
    | { ok: false; reason: string };
  /**
   * Spawn a thread with an inline agent definition, inheriting the coordinator's
   * model, tools, MCP servers, and skills. Records the same created/sent/received
   * sequence as a predefined dispatch.
   */
  dispatchInlineAgent(input: {
    definition: InlineSubagentDefinition;
    message: string;
  }):
    | { ok: true; thread: SessionThread; created: boolean }
    | { ok: false; reason: string };
}

/**
 * Build the `list_agents` and `send_to_agent` tools for a coordinator thread.
 *
 * Returns an empty map for a thread with no roster — the runtime check that
 * mirrors the write-time one-level rule: a roster member's thread never holds
 * these, so delegation cannot recurse past the level the coordinator serves.
 */
export function buildCoordinatorTools(
  agent: AgentDefinition,
  host: CoordinatorToolsHost,
): Record<string, any> {
  const members = subagentMembers(agent);
  const inlineEnabled = inlineSubagentsEnabled(agent);
  if (members.length === 0 && !inlineEnabled) return {};
  const coordinatorName = agent.name;

  return {
    list_agents: {
      description:
        'List the agents this coordinator may delegate to, and the threads already running in this session. ' +
        'Each subagent is reported by `name` (the value `send_to_agent` takes) and description; each live ' +
        'thread is reported by `thread_id`, `agent_name`, and `status` so a follow-up can be addressed to it.',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async () => {
        const agents = members.map((member) => {
          const isSelf = member.id === host.parentThread.agentId;
          return {
            name: isSelf ? coordinatorName : memberName(member, host),
            description: isSelf
              ? 'A copy of this coordinator running the same configuration'
              : memberDescription(member, host),
            agent_id: member.id,
            version: member.version,
          };
        });
        const threads = host.listThreads()
          .filter((thread) => thread.id !== host.parentThread.id && !thread.archivedAt)
          .map((thread) => ({
            thread_id: thread.id,
            agent_name: thread.agentName,
            status: thread.status,
          }));
        return JSON.stringify({ agents, threads });
      },
    },

    send_to_agent: {
      description:
        'Send a task or a follow-up message to a subagent. Pass `agent` to address a predefined subagent, or ' +
        '`inline_agent` to spawn one from the coordinator\'s own model, tools, MCP servers, and skills with a ' +
        'thread-specific name, description, and system prompt. Without `thread_id` a new thread is spawned; ' +
        'with `thread_id` the message is a follow-up to that agent\'s existing thread, which keeps its full ' +
        'prior context. Returns immediately with the thread\'s id — the reply arrives back as a message here.',
      parameters: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'A predefined subagent\'s name' },
          inline_agent: {
            type: 'object',
            description: 'A thread-scoped agent definition; inherits the coordinator\'s model, tools, MCP servers, and skills',
            properties: {
              name: { type: 'string', description: 'The name this inline agent is known by' },
              description: { type: 'string', description: 'An optional description for list_agents and the thread' },
              system: { type: 'string', description: 'An optional system prompt override' },
            },
            required: ['name'],
          },
          message: { type: 'string', description: 'The task or follow-up message to send' },
          thread_id: {
            type: 'string',
            description: 'An existing thread to send a follow-up into; omit to spawn a new thread',
          },
        },
        required: ['message'],
      },
      execute: async (input: {
        agent?: string;
        inline_agent?: InlineSubagentDefinition;
        message?: string;
        thread_id?: string;
      }) => {
        if (typeof input.message !== 'string' || input.message.length === 0) {
          return toolError('send_to_agent requires a non-empty `message`.');
        }
        if (input.inline_agent !== undefined) {
          if (input.agent !== undefined) {
            return toolError('Pass either `agent` or `inline_agent`, not both.');
          }
          if (input.thread_id !== undefined) {
            return toolError('An inline agent starts a new thread; omit `thread_id`.');
          }
          if (!inlineEnabled) {
            return toolError('This coordinator does not allow inline subagents.');
          }
          const name = typeof input.inline_agent.name === 'string' ? input.inline_agent.name.trim() : '';
          if (name.length === 0 || name.length > 128) {
            return toolError('`inline_agent.name` must be between 1 and 128 characters.');
          }
          const outcome = host.dispatchInlineAgent({
            definition: {
              name,
              ...(typeof input.inline_agent.description === 'string'
                ? { description: input.inline_agent.description } : {}),
              ...(typeof input.inline_agent.system === 'string'
                ? { system: input.inline_agent.system } : {}),
            },
            message: input.message,
          });
          if (!outcome.ok) return toolError(outcome.reason);
          return JSON.stringify({ thread_id: outcome.thread.id, status: 'sent' });
        }
        const member = resolveMemberByName(members, input.agent, host, coordinatorName);
        if (!member) {
          return toolError(`No subagent named "${input.agent ?? ''}". Call list_agents for the members.`);
        }
        const outcome = host.dispatchToAgent({
          member,
          message: input.message,
          ...(input.thread_id !== undefined ? { threadId: input.thread_id } : {}),
        });
        if (!outcome.ok) {
          return toolError(outcome.reason);
        }
        return JSON.stringify({ thread_id: outcome.thread.id, status: 'sent' });
      },
    },
  };
}

/**
 * Resolve a roster member by the name the coordinator calls it. `self` answers
 * to the coordinator's own name — that is the member's name as `list_agents`
 * reports it, so the two tools agree on the same vocabulary.
 */
function resolveMemberByName(
  members: readonly CoordinatorMember[],
  name: string | undefined,
  host: CoordinatorToolsHost,
  coordinatorName: string,
): CoordinatorMember | undefined {
  if (typeof name !== 'string' || name.length === 0) return undefined;
  return members.find((member) => {
    const memberDisplayName = member.id === host.parentThread.agentId
      ? coordinatorName
      : memberName(member, host);
    return memberDisplayName === name;
  });
}

/**
 * The name a roster member is known by on the wire. `list_agents` reports it
 * and `send_to_agent` resolves it back, so the two must derive it identically.
 * A member's durable agent name is what the roster pinned; the host resolves
 * the id to it, falling back to the id itself when the row is gone.
 */
function memberName(
  member: CoordinatorMember,
  host: CoordinatorToolsHost,
): string {
  return host.agentNameFor(member.id) ?? member.id;
}

function memberDescription(
  member: CoordinatorMember,
  host: CoordinatorToolsHost,
): string {
  return host.agentDescriptionFor(member.id) ?? '';
}
