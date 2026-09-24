import type { AgentDefinition, McpServerConfig } from '@/types/agent.js';
import type { SandboxInstance } from '@/types/sandbox.js';
import type { Session, SessionEvent } from '@/types/session.js';
import type { UserEvent } from '@/types/cma-protocol.js';
import { memoryBindingForPath, resolveMemoryBindings, type MemoryBinding } from '@/core/memory/bindings.js';
import type { MemoryMountAdapter } from '@/core/memory/mount-adapter.js';
import { memoryContentHash } from '@/core/memory/semantics.js';
import { normalizeMemoryRecordPath } from '@/core/memory/mount-adapter.js';
import { collectGrepHits, editOnce, mountProviderUnavailable, mountRelativePath, refuseBashOnMemoryMount, type SessionMemoryMount } from './memory-mount-tools.js';
import { McpManager, type McpServerStatus } from '@/core/mcp/mcp-manager.js';
import { rootDelegationContext, DEFAULT_MAX_DELEGATION_DEPTH } from '@/core/orchestrator/agent-orchestrator.js';
import type { EventLogger } from './event-logger.js';
import type { DelegationService } from './delegation-service.js';
import { getCustomToolConfigs, getCustomToolNames, getEnabledToolNames, mcpDiscoveredToolAdmitted, resolveToolsRequiringConfirmation } from '@/core/agent/standard.js';
import { resolveWebToolExecutionPolicy } from '@/core/agent/web-tool-policy.js';
import { createWebFetchTool, type WebFetchOverrides } from '@/core/web/web-fetch.js';
import type { SecretRedactor } from '@/core/credentials/redaction.js';
import { clearCredentialInjectionBundle, createCredentialRedactor } from '@/core/credentials/redaction.js';
import type { CredentialInjectionBundle, CredentialInjectionTarget } from '@/core/credentials/injection.js';

/**
 * Vault-derived material one turn's sandbox tools use.
 *
 * Passed in per turn rather than held on the resolver, so nothing retains a
 * secret past the turn that resolved it.
 */
export type SandboxCredentials = {
  /** Environment variables the session's vaults contributed. */
  env: Record<string, string>;
  /** Scrubs vault secret values out of everything a tool hands back. */
  redactor: SecretRedactor;
};

export interface ToolResolverDeps {
  delegationService: DelegationService;
  /**
   * WebFetch transport overrides (DNS resolution, address guard, limits).
   *
   * Constructor-level only: an agent definition cannot reach it, so no
   * model-facing or API-facing input can relax the guard.
   */
  webFetch?: WebFetchOverrides;
  /** Path-addressed memory provider. Mount calls fail closed when absent. */
  memoryMount?: MemoryMountAdapter;
  memoryStoreName?: (storeId: string) => string | undefined;
  /**
   * Resolve a session's vault credentials for one MCP connection.
   *
   * Optional: a runtime with no vault store passes nothing, and an agent whose
   * servers are all anonymous needs nothing. The resolver enforces the network
   * policy before it decrypts anything, so a credential this session cannot use
   * comes back in `denied` rather than in the environment. The caller names the
   * server it is connecting to, because a credential keyed by `mcp_server_url`
   * only applies to the endpoint it names.
   */
  resolveCredentialInjections?: (sessionId: string, target?: CredentialInjectionTarget) => CredentialInjectionBundle;
}

export interface ToolConfirmationResolution {
  /** Whether the referenced tool call was pending and has been resolved. */
  handled: boolean;
  /** Whether every approval-gated call from the model step now has a result. */
  groupComplete: boolean;
}

interface PendingToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
  confirmationGroupId?: string;
}

export class ToolResolver {
  private readonly mcpManagers = new Map<string, McpManager>();
  private readonly mcpToolCache = new Map<string, Record<string, unknown>>();

  constructor(private readonly deps: ToolResolverDeps) {}

  async resolveTools(
    session: Session,
    agent: AgentDefinition,
    sandbox: SandboxInstance,
    credentials?: SandboxCredentials,
  ): Promise<Record<string, any>> {
    const bindings = resolveMemoryBindings(session.resources, this.deps.memoryStoreName);
    const mount = this.deps.memoryMount ? { adapter: this.deps.memoryMount, sessionId: session.id } : undefined;
    const delegationCtx = rootDelegationContext(agent.name, DEFAULT_MAX_DELEGATION_DEPTH);
    const tools = this.buildSandboxTools(agent, sandbox, bindings, mount, credentials);
    Object.assign(tools, await this.getOrConnectMcp(session.id, agent));
    Object.assign(tools, this.deps.delegationService.buildDelegationTools(agent, delegationCtx, session));
    // Custom tools are model-visible declarations only. The caller executes them
    // and answers through `user.custom_tool_result`, so the entry carries the
    // description and input schema the model needs and no `execute` at all.
    const customNames = new Set(getCustomToolNames(agent));
    for (const config of getCustomToolConfigs(agent)) {
      if (!customNames.has(config.name)) continue;
      tools[config.name] = {
        description: config.description,
        parameters: config.parameters,
      };
    }

    // Derived from the resolved map rather than only from the declaration: an MCP
    // server exposes its tool list at connect time, so a discovered tool the
    // agent never named appears in no configs entry and a declaration-only list
    // cannot gate it.
    for (const name of resolveToolsRequiringConfirmation(agent, Object.keys(tools))) {
      if (tools[name]) {
        tools[name] = { ...tools[name], execute: undefined };
      }
    }

    return tools;
  }

  /**
   * Execute or deny the pending tool call referenced by a confirmation event.
   * Returns the resolved state for the referenced call. The caller may resume
   * the model only after every tool call in its confirmation group has a paired
   * result; otherwise the session remains in requires_action.
   */
  async handleToolConfirmation(
    session: Session,
    agent: AgentDefinition,
    sandbox: SandboxInstance,
    event: Extract<UserEvent, { type: 'user.tool_confirmation' }>,
    eventLogger: EventLogger,
    broadcast: (event: SessionEvent) => void,
  ): Promise<ToolConfirmationResolution> {
    const events = eventLogger.getEvents(session.id);

    const resolved = new Set<string>();
    const pendingUses: PendingToolUse[] = [];
    let pendingUse: PendingToolUse | undefined;
    for (const loggedEvent of events) {
      if (loggedEvent.type === 'agent.tool_use' || loggedEvent.type === 'agent.mcp_tool_use') {
        const block = loggedEvent.content?.find((item) => item.type === 'tool_use') as
          | {
            type: 'tool_use';
            id: string;
            name: string;
            input: Record<string, unknown>;
            requires_confirmation?: boolean;
            confirmation_group_id?: string;
          }
          | undefined;
        if (!block?.requires_confirmation) continue;
        const candidate: PendingToolUse = {
          id: block.id,
          name: block.name,
          input: block.input,
          confirmationGroupId: block.confirmation_group_id
            ?? (typeof loggedEvent.metadata?.confirmation_group_id === 'string'
              ? loggedEvent.metadata.confirmation_group_id
              : undefined),
        };
        pendingUses.push(candidate);
        // The published contract circulates the `tool_use` **event** id and local
        // callers use the `tool_use` **block** id, so the reference may be either.
        // Only `candidate.id` — the block id — is used from here on: the tool
        // result that pairs this call back to its block, the resolved set, and
        // the group membership are all keyed by tool-call id, so answering with
        // an event id must not leak into any of them.
        if (candidate.id === event.tool_use_id || loggedEvent.id === event.tool_use_id) {
          pendingUse = candidate;
        }
      } else if (loggedEvent.type === 'agent.tool_result' || loggedEvent.type === 'agent.mcp_tool_result') {
        const block = loggedEvent.content?.find((item) => item.type === 'tool_result') as
          | { type: 'tool_result'; tool_use_id: string } | undefined;
        if (block) resolved.add(block.tool_use_id);
      }
    }

    if (!pendingUse || resolved.has(pendingUse.id)) {
      return { handled: false, groupComplete: false };
    }

    let resultText: string;
    let isError = false;
    if (event.result === 'allow') {
      const bindings = resolveMemoryBindings(session.resources, this.deps.memoryStoreName);
      const mount = this.deps.memoryMount ? { adapter: this.deps.memoryMount, sessionId: session.id } : undefined;
      const executableTools = this.buildSandboxTools(agent, sandbox, bindings, mount);
      Object.assign(executableTools, this.mcpToolCache.get(session.id) ?? {});
      Object.assign(
        executableTools,
        this.deps.delegationService.buildDelegationTools(
          agent,
          rootDelegationContext(agent.name, DEFAULT_MAX_DELEGATION_DEPTH),
          session,
        ),
      );
      const tool = executableTools[pendingUse.name];
      if (tool?.execute) {
        try {
          const out = await tool.execute(pendingUse.input);
          resultText = typeof out === 'string' ? out : JSON.stringify(out);
        } catch (err) {
          resultText = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
          isError = true;
        }
      } else {
        resultText = `Tool "${pendingUse.name}" is not executable`;
        isError = true;
      }
    } else {
      resultText = event.deny_message
        ? `Tool call denied by user: ${event.deny_message}`
        : 'Tool call denied by user';
      isError = true;
    }

    const groupId = pendingUse.confirmationGroupId ?? pendingUse.id;
    const resultEvent = eventLogger.append(session.id, {
      type: 'agent.tool_result',
      content: [{ type: 'tool_result', tool_use_id: pendingUse.id, content: resultText, is_error: isError }],
      metadata: { confirmation_group_id: groupId },
    });
    broadcast(resultEvent);

    const groupComplete = pendingUses
      .filter((toolUse) => (toolUse.confirmationGroupId ?? toolUse.id) === groupId)
      .every((toolUse) => resolved.has(toolUse.id) || toolUse.id === pendingUse.id);
    return { handled: true, groupComplete };
  }

  async cleanupSession(sessionId: string): Promise<void> {
    const mcp = this.mcpManagers.get(sessionId);
    if (!mcp) return;

    this.mcpManagers.delete(sessionId);
    this.mcpToolCache.delete(sessionId);
    try {
      await mcp.close();
    } catch {
      // best-effort cleanup
    }
  }

  getMcpStatus(sessionId: string): McpServerStatus[] {
    return this.mcpManagers.get(sessionId)?.getStatuses() ?? [];
  }

  buildSandboxTools(
    agent: AgentDefinition,
    sandbox: SandboxInstance,
    bindings: readonly MemoryBinding[] = [],
    memoryMount?: SessionMemoryMount,
    credentials?: SandboxCredentials,
  ): Record<string, any> {
    const tools: Record<string, any> = {};
    const enabledTools = new Set(getEnabledToolNames(agent));
    const mount = memoryMount ?? (this.deps.memoryMount ? { adapter: this.deps.memoryMount, sessionId: 'unknown' } : undefined);

    const mounted = (path: string) => memoryBindingForPath(bindings, path);
    const mountError = (binding: MemoryBinding): string => mount
      ? mountProviderUnavailable(binding.mountPath)
      : mountProviderUnavailable(binding.mountPath);
    const readMounted = (path: string) => {
      const binding = mounted(path);
      if (!binding) return undefined;
      if (!mount) return mountError(binding);
      const relative = mountRelativePath(path, binding);
      const checked = normalizeMemoryRecordPath(relative);
      if (!checked.ok) return `Error: ${checked.error.message}`;
      const result = mount.adapter.read(binding.storeId, checked.value);
      return result.ok ? result.value.content : `Error: ${result.error.message}`;
    };

    if (enabledTools.has('bash')) {
      tools['bash'] = {
        description: 'Execute a shell command in the sandbox',
        parameters: { type: 'object', properties: { command: { type: 'string', description: 'Shell command to execute' } }, required: ['command'] },
        execute: async ({ command }: { command: string }) => {
          const refusal = refuseBashOnMemoryMount(command, bindings);
          if (refusal) return refusal;
          // A shell command declares no target host, so only a credential the
          // policy admits without one reaches the environment.
          const result = await sandbox.execute(
            command,
            credentials && Object.keys(credentials.env).length > 0 ? { env: credentials.env } : undefined,
          );
          return result.exitCode === 0 ? result.stdout : `Error (exit ${result.exitCode}): ${result.stderr}`;
        },
      };
    }

    if (enabledTools.has('read')) {
      tools['read'] = {
        description: 'Read a file from the workspace',
        parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path relative to workspace' } }, required: ['path'] },
        execute: async ({ path }: { path: string }) => {
          const mountedContent = readMounted(path);
          if (mountedContent !== undefined) return mountedContent;
          try { return await sandbox.readFile(path); } catch (err: any) { return `Error: ${err.message}`; }
        },
      };
    }

    if (enabledTools.has('write')) {
      tools['write'] = {
        description: 'Write content to a file in the workspace',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path relative to workspace' },
            content: { type: 'string', description: 'File content to write' },
            precondition_sha256: { type: 'string', description: 'Hash of the content last read' },
          },
          required: ['path', 'content'],
        },
        execute: async ({ path, content, precondition_sha256 }: { path: string; content: string; precondition_sha256?: string }) => {
          const binding = mounted(path);
          if (binding) {
            const relative = mountRelativePath(path, binding);
            const checked = normalizeMemoryRecordPath(relative);
            if (!checked.ok) return `Error: ${checked.error.message}`;
            if (binding.access === 'read_only') return `Error: ${binding.mountPath} is a read-only memory mount; writes to it are not permitted.`;
            if (!mount) return mountError(binding);
            const result = mount.adapter.upsert(binding.storeId, checked.value, content, {
              sessionId: mount.sessionId,
              preconditionSha256: precondition_sha256,
            });
            return result.ok ? `Written ${content.length} bytes to ${path} (version ${result.value.version})` : `Error: ${result.error.message}`;
          }
          await sandbox.writeFile(path, content);
          return `Written ${content.length} bytes to ${path}`;
        },
      };
    }

    if (enabledTools.has('edit')) {
      tools['edit'] = {
        description: 'Replace an exact string in a file with new content',
        parameters: { type: 'object', properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['path', 'old_string', 'new_string'] },
        execute: async ({ path, old_string, new_string }: { path: string; old_string: string; new_string: string }) => {
          const binding = mounted(path);
          if (binding) {
            const relative = mountRelativePath(path, binding);
            const checked = normalizeMemoryRecordPath(relative);
            if (!checked.ok) return `Error: ${checked.error.message}`;
            if (binding.access === 'read_only') return `Error: ${binding.mountPath} is a read-only memory mount; writes to it are not permitted.`;
            if (!mount) return mountError(binding);
            const current = mount.adapter.read(binding.storeId, checked.value);
            if (!current.ok) return `Error: ${current.error.message}`;
            const edited = editOnce(current.value.content, old_string, new_string, path);
            if (!edited.ok) return edited.message;
            const result = mount.adapter.update(binding.storeId, mountRelativePath(path, binding), edited.value, {
              sessionId: mount.sessionId,
              preconditionSha256: memoryContentHash(current.value.content),
            });
            return result.ok ? `Edited ${path} (version ${result.value.version})` : `Error: ${result.error.message}`;
          }
          try {
            const current = await sandbox.readFile(path);
            const edited = editOnce(current, old_string, new_string, path);
            if (!edited.ok) return edited.message;
            await sandbox.writeFile(path, edited.value);
            return `Edited ${path}`;
          } catch (err: any) { return `Error: ${err.message}`; }
        },
      };
    }

    if (enabledTools.has('glob')) {
      tools['glob'] = {
        description: 'List files in the workspace matching a substring or extension',
        parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] },
        execute: async ({ pattern, path }: { pattern: string; path?: string }) => {
          const binding = path ? mounted(path) : undefined;
          if (binding) {
            if (!mount) return mountError(binding);
            const result = mount.adapter.list(binding.storeId);
            if (!result.ok) return `Error: ${result.error.message}`;
            const relativeScope = mountRelativePath(path!, binding);
            const files = result.value
              .filter((file) => relativeScope === '/' || file.path === relativeScope || file.path.startsWith(`${relativeScope.replace(/\/$/, '')}/`))
              .map((file) => `${binding.mountPath}${file.path}`)
              .filter((file) => file.includes(pattern));
            return files.length > 0 ? files.join('\n') : `No files matching "${pattern}"`;
          }
          const files = await sandbox.listFiles(path ?? '.');
          const matched = files.filter((file) => file.includes(pattern));
          return matched.length > 0 ? matched.join('\n') : `No files matching "${pattern}"`;
        },
      };
    }

    if (enabledTools.has('grep')) {
      tools['grep'] = {
        description: 'Search file contents in the workspace for a substring',
        parameters: { type: 'object', properties: { query: { type: 'string' }, path: { type: 'string' } }, required: ['query'] },
        execute: async ({ query, path }: { query: string; path?: string }) => {
          const binding = path ? mounted(path) : undefined;
          if (binding) {
            if (!mount) return mountError(binding);
            const result = mount.adapter.list(binding.storeId);
            if (!result.ok) return `Error: ${result.error.message}`;
            const scope = mountRelativePath(path!, binding);
            const hits: string[] = [];
            for (const file of result.value) {
              if (scope !== '/' && file.path !== scope && !file.path.startsWith(`${scope.replace(/\/$/, '')}/`)) continue;
              collectGrepHits(hits, `${binding.mountPath}${file.path}`, file.content, query);
            }
            return hits.length > 0 ? hits.slice(0, 200).join('\n') : `No matches for "${query}"`;
          }
          const files = await sandbox.listFiles(path ?? '.');
          const hits: string[] = [];
          for (const file of files) {
            try { collectGrepHits(hits, file, await sandbox.readFile(file), query); } catch { /* skip unreadable files */ }
          }
          return hits.length > 0 ? hits.slice(0, 200).join('\n') : `No matches for "${query}"`;
        },
      };
    }

    if (enabledTools.has('web_fetch')) {
      tools['web_fetch'] = createWebFetchTool({ policy: resolveWebToolExecutionPolicy(agent, 'web_fetch'), overrides: this.deps.webFetch });
    }

    // Everything a tool hands back is scrubbed in one place, so a tool added
    // later cannot forget a secret it happened to echo.
    if (credentials) {
      for (const [name, tool] of Object.entries(tools)) {
        const execute = tool?.execute;
        if (typeof execute !== 'function') continue;
        tools[name] = {
          ...tool,
          execute: async (input: unknown) => credentials.redactor(await execute(input)),
        };
      }
    }
    return tools;
  }

  /**
   * Reconnect a session's MCP servers through their credential resolver.
   *
   * Called when a vault the session references is rotated, so each transport is
   * rebuilt with the value the session holds now. A session with no connected server
   * has nothing to refresh and is left alone; the cached tool wrappers stay valid
   * because they delegate through the manager's live tool map.
   */
  async refreshSessionMcpCredentials(sessionId: string): Promise<void> {
    const manager = this.mcpManagers.get(sessionId);
    if (!manager) return;
    this.mcpToolCache.set(sessionId, await manager.refreshAllCredentials());
  }

  private async getOrConnectMcp(
    sessionId: string,
    agent: AgentDefinition,
  ): Promise<Record<string, unknown>> {
    if (!agent.mcp_servers || agent.mcp_servers.length === 0) {
      return {};
    }

    const existing = this.mcpManagers.get(sessionId);
    if (existing) {
      return this.mcpToolCache.get(sessionId) ?? {};
    }

    // A stdio server is a local process rather than an outbound call, so it names
    // neither a host nor a URL: exactly as for a shell command, an `unrestricted`
    // credential is injected and a `limited` one is denied by the policy. A url
    // server names both, so the policy can check its host and a credential keyed by
    // `mcp_server_url` can be matched against the endpoint it was minted for.
    const resolveCredentials = this.deps.resolveCredentialInjections
      ? (server: McpServerConfig) => this.deps.resolveCredentialInjections!(sessionId, server.type === 'url' && server.url
        ? { targetHost: server.url, mcpServerUrl: server.url }
        : undefined)
      : undefined;
    const manager = new McpManager({
      // A server's tool list is only known after connect, so the owning
      // toolset's admission rule is applied here rather than to a declared list.
      admitTool: (serverName, toolName) => mcpDiscoveredToolAdmitted(agent, serverName, toolName),
      resolveEnvironment: resolveCredentials
        ? (server) => {
          const bundle = resolveCredentials(server);
          const environment = { ...bundle.environment };
          // The bundle belongs to this connect: the copy above is what the server
          // process receives, and the manager empties that copy after the spawn.
          clearCredentialInjectionBundle(bundle);
          return environment;
        }
        : undefined,
      resolveHeaders: resolveCredentials
        ? (server) => {
          const bundle = resolveCredentials(server);
          const headers = { ...bundle.request_headers };
          // Same lifetime rule as the environment: the transport keeps the copy it
          // presents on every request, the resolver's record does not survive it.
          clearCredentialInjectionBundle(bundle);
          return headers;
        }
        : undefined,
      redactResult: resolveCredentials
        ? (serverName, result) => {
          // The scrub has to know which server produced the value, because a
          // credential keyed by `mcp_server_url` applies to one endpoint only.
          const server = (agent.mcp_servers ?? []).find((candidate) => candidate.name === serverName);
          if (!server) return result;
          // Resolved per call rather than captured once, so what gets scrubbed is
          // the value the session holds now; cleared immediately afterwards so
          // neither the redactor nor its bundle outlives the call.
          const bundle = resolveCredentials(server);
          const redactor = createCredentialRedactor(bundle);
          try {
            return redactor(result);
          } finally {
            redactor.clear();
            clearCredentialInjectionBundle(bundle);
          }
        }
        : undefined,
    });
    const tools = await manager.connectAll(agent.mcp_servers);
    this.mcpManagers.set(sessionId, manager);
    this.mcpToolCache.set(sessionId, tools);
    return tools;
  }
}
