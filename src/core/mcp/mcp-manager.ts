/**
 * MCP Client Manager (Requirement 5)
 *
 * Connects to MCP servers declared in an Agent definition and exposes their
 * tools to the engine loop. Uses the official MCP SDK client
 * (`@modelcontextprotocol/sdk`), since the Vercel AI SDK removed the
 * `experimental_createMCPClient` wrapper this used to go through.
 *
 * Transports:
 * - stdio: spawns a subprocess and speaks MCP over stdin/stdout
 * - url:    connects to an HTTP/SSE MCP endpoint
 *
 * Degradation (R5.5): a server that fails to connect within the timeout is
 * logged, marked unavailable, and skipped — the agent keeps running with
 * whatever tools did connect.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { resolveEnvVarsDeep } from '@/core/config/env-resolver.js';
import type { McpServerConfig } from '@/types/agent.js';

/** Default connect + tools/list timeout (ms). */
const DEFAULT_MCP_TIMEOUT_MS = 30_000;

/** Reconnect policy (R5.6): exponential backoff, max 60s interval, 5 attempts. */
const RECONNECT_MAX_ATTEMPTS = 5;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;

/** Compute the backoff delay for a given attempt (0-indexed): 1s,2s,4s,…,60s cap. */
export function reconnectDelay(attempt: number): number {
  return Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
}

/**
 * The runtime naming rule now lives in `tool-naming.ts` so the permission layer
 * can reuse it without importing the MCP client stack. Re-exported here so an
 * existing importer of this module keeps working.
 */
export { MCP_TOOL_PREFIX, mcpToolName, mcpServerToolPrefix, resolveMcpServerName } from './tool-naming.js';

import { mcpToolName } from './tool-naming.js';

export interface McpServerStatus {
  name: string;
  type: 'stdio' | 'url';
  connected: boolean;
  toolCount: number;
  error?: string;
}

interface McpClient {
  tools(): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

/**
 * Manages the lifecycle of MCP client connections for a single session/agent.
 * One instance per session; call close() on session teardown.
 */
export interface McpManagerOptions {
  /**
   * Admission rule for a tool the server actually exposed.
   *
   * A server's tool list is only known after `tools/list`, so the agent's
   * declared `configs` cannot decide admission on their own. The caller supplies
   * the rule (derived from the owning `mcp_toolset`) so a discovered tool the
   * operator disabled, or one that should be approval-gated, is filtered at
   * discovery rather than shipped and hoped to be gated later. Absent means
   * "admit everything", which keeps direct `McpManager` construction usable.
   */
  admitTool?: (serverName: string, toolName: string) => boolean;
  /**
   * Environment a stdio server's process should receive in addition to the
   * `env` its own configuration declares.
   *
   * The caller supplies this so a session's Vault material reaches the server
   * without the agent definition ever carrying it: a value an agent writes into
   * `env` is configuration, not an operator-authorized credential. The returned
   * record is copied into the spawn environment and then emptied, so this
   * manager does not retain the values past the process start. Absent means
   * "declare nothing extra".
   */
  resolveEnvironment?: (server: McpServerConfig) => Record<string, string> | undefined;
  /**
   * Request headers a url-transport server's connection should carry.
   *
   * The SDK sends the initial SSE request through `eventSourceInit.fetch` and every
   * message POST through `requestInit`, so a caller-supplied credential has to reach
   * both or the server sees it on one leg only. The returned record is copied into
   * the transport and then emptied, so this manager does not retain the values; the
   * transport holds the copy it presents for the life of the connection. Absent
   * means "send no extra headers".
   */
  resolveHeaders?: (server: McpServerConfig) => Record<string, string> | undefined;
  /**
   * Scrub a tool result before the strategy hands it to the model.
   *
   * A server that echoes the credential it was given would otherwise put the
   * secret into the transcript, and only the caller knows what it injected, so
   * the rule has to come from there. Absent means "return the result unchanged".
   */
  redactResult?: (serverName: string, result: unknown) => unknown;
}

export class McpManager {
  private readonly admitTool: ((serverName: string, toolName: string) => boolean) | undefined;
  private readonly resolveEnvironment: ((server: McpServerConfig) => Record<string, string> | undefined) | undefined;
  private readonly resolveHeaders: ((server: McpServerConfig) => Record<string, string> | undefined) | undefined;
  private readonly redactResult: ((serverName: string, result: unknown) => unknown) | undefined;
  private clients = new Map<string, McpClient>();
  private serverConfigs = new Map<string, McpServerConfig>();
  private statuses: McpServerStatus[] = [];
  /** Current live (un-namespaced) tool defs per server, refreshed on reconnect. */
  private liveTools = new Map<string, Record<string, any>>();

  constructor(options: McpManagerOptions = {}) {
    this.admitTool = options.admitTool;
    this.resolveEnvironment = options.resolveEnvironment;
    this.resolveHeaders = options.resolveHeaders;
    this.redactResult = options.redactResult;
  }
  /** Sleep function (injectable for tests). */
  private sleepFn: (ms: number) => Promise<void> = sleep;

  /** Override the sleep function (test hook for backoff). */
  setSleepFn(fn: (ms: number) => Promise<void>): void {
    this.sleepFn = fn;
  }

  /**
   * Connect to all configured MCP servers and return their merged tool set.
   * Servers that fail to connect are skipped (degraded mode). Returned tools
   * are wrapped so that a connection-drop error during a tool call triggers an
   * automatic reconnect + retry (R5.6, L5).
   */
  async connectAll(servers: McpServerConfig[]): Promise<Record<string, unknown>> {
    const merged: Record<string, unknown> = {};

    for (const server of servers) {
      // Record the config so a server that's down now can be reconnected later.
      this.serverConfigs.set(server.name, server);
      // Initial connect is fast-degrade (R5.5): one attempt, skip on failure.
      const result = await this.tryConnect(server);
      if (result) {
        this.clients.set(server.name, result.client);
        this.liveTools.set(server.name, result.tools);
        let count = 0;
        for (const toolName of Object.keys(result.tools)) {
          // A denied tool is dropped here rather than shipped and gated later:
          // shipping it invites the model to call something the operator forbade.
          if (this.admitTool && !this.admitTool(server.name, toolName)) continue;
          merged[mcpToolName(server.name, toolName)] = this.wrapTool(server.name, toolName);
          count++;
        }
        this.setStatus(server, true, count);
      } else {
        this.setStatus(server, false, 0, 'initial connect failed');
      }
    }

    return merged;
  }

  /**
   * Build a stable tool wrapper for `mcp_<server>_<toolName>`. Its execute
   * delegates to the current live tool; on a connection-drop error it reconnects
   * the server (with backoff) and retries once against the refreshed tool.
   */
  private wrapTool(serverName: string, toolName: string): Record<string, unknown> {
    const current = this.liveTools.get(serverName)?.[toolName];
    return {
      description: current?.description,
      parameters: current?.parameters,
      execute: async (args: unknown) => {
        const tool = this.liveTools.get(serverName)?.[toolName];
        if (!tool?.execute) throw new Error(`MCP tool "${toolName}" unavailable`);
        try {
          return this.scrub(serverName, await tool.execute(args));
        } catch (err) {
          if (!isConnectionError(err)) throw err;
          // Connection likely dropped — reconnect and retry once.
          const ok = await this.reconnect(serverName, this.sleepFn);
          if (!ok) throw err;
          const fresh = this.liveTools.get(serverName)?.[toolName];
          if (!fresh?.execute) throw err;
          return this.scrub(serverName, await fresh.execute(args));
        }
      },
    };
  }

  /**
   * Apply the caller's scrubbing rule, if any, to a result the model is about
   * to see. Kept as one method so the retry path cannot skip it.
   */
  private scrub(serverName: string, result: unknown): unknown {
    return this.redactResult ? this.redactResult(serverName, result) : result;
  }

  /**
   * Reconnect a server whose connection dropped mid-session (R5.6): retries
   * with exponential backoff (1s→2s→4s…, capped 60s), up to 5 attempts.
   * Returns the reconnected tool set, or null after exhausting attempts.
   * `sleepFn` is injectable for testing.
   */
  async reconnect(
    serverName: string,
    sleepFn: (ms: number) => Promise<void> = sleep,
  ): Promise<Record<string, unknown> | null> {
    const server = this.serverConfigs.get(serverName);
    if (!server) return null;

    for (let attempt = 0; attempt < RECONNECT_MAX_ATTEMPTS; attempt++) {
      const result = await this.tryConnect(server);
      if (result) {
        // Replace the dead client + refresh the live tool defs (wrappers in the
        // strategy's tool map delegate to these, so they pick up the new client).
        await this.clients.get(serverName)?.close().catch(() => {});
        this.clients.set(serverName, result.client);
        this.liveTools.set(serverName, result.tools);
        const tools: Record<string, unknown> = {};
        let count = 0;
        for (const toolName of Object.keys(result.tools)) {
          if (this.admitTool && !this.admitTool(serverName, toolName)) continue;
          tools[mcpToolName(serverName, toolName)] = this.wrapTool(serverName, toolName);
          count++;
        }
        this.setStatus(server, true, count);
        return tools;
      }
      if (attempt < RECONNECT_MAX_ATTEMPTS - 1) {
        await sleepFn(reconnectDelay(attempt));
      }
    }
    this.setStatus(server, false, 0, `reconnect failed after ${RECONNECT_MAX_ATTEMPTS} attempts`);
    return null;
  }

  /** Single connect attempt. Returns null on failure (no throw). */
  private async tryConnect(
    server: McpServerConfig,
  ): Promise<{ client: McpClient; tools: Record<string, unknown> } | null> {
    const timeout = (server.timeout ?? 30) * 1000 || DEFAULT_MCP_TIMEOUT_MS;
    let client: McpClient | undefined;
    try {
      client = await withTimeout(
        this.createClient(server),
        timeout,
        `MCP server "${server.name}" connect timed out after ${timeout}ms`,
      );
      const tools = await withTimeout(
        client.tools(),
        timeout,
        `MCP server "${server.name}" tools/list timed out`,
      );
      return { client, tools };
    } catch {
      // Close a client that connected but failed tools/list, so we don't
      // orphan its subprocess/socket (M4).
      if (client) await client.close().catch(() => {});
      return null;
    }
  }

  private setStatus(server: McpServerConfig, connected: boolean, toolCount: number, error?: string): void {
    const existing = this.statuses.findIndex((s) => s.name === server.name);
    const status: McpServerStatus = { name: server.name, type: server.type, connected, toolCount, error };
    if (existing >= 0) this.statuses[existing] = status;
    else this.statuses.push(status);
  }

  /** Connection status for each configured server (for /v1/x/mcp/status). */
  getStatuses(): McpServerStatus[] {
    return this.statuses;
  }

  /** Close all MCP client connections (subprocess kill / socket close). */
  async close(): Promise<void> {
    await Promise.all(
      Array.from(this.clients.values()).map((c) => c.close().catch(() => {})),
    );
    this.clients.clear();
  }

  // ============================================================
  // Internal
  // ============================================================

  private async createClient(server: McpServerConfig): Promise<McpClient> {
    let transport;
    // Credential material contributed by the resolver, kept only until the
    // connection is established.
    let injectedEnv: Record<string, string> | undefined;
    let injectedHeaders: Record<string, string> | undefined;
    if (server.type === 'stdio') {
      if (!server.command) {
        throw new Error(`MCP server "${server.name}": stdio transport requires "command"`);
      }
      const configuredEnv = server.env ? resolveEnvVarsDeep(server.env, false) : {};
      injectedEnv = this.resolveEnvironment?.(server);
      // Vault values win over the agent's own configuration: an agent must not
      // be able to replace an operator-authorized credential with a value of its
      // own choosing.
      const env = { ...configuredEnv, ...(injectedEnv ?? {}) };
      transport = new StdioClientTransport({
        command: server.command,
        args: server.args ?? [],
        env: Object.keys(env).length > 0 ? env : undefined,
      });
    } else {
      if (!server.url) {
        throw new Error(`MCP server "${server.name}": url transport requires "url"`);
      }
      const url = resolveEnvVarsDeep(server.url, false);
      injectedHeaders = this.resolveHeaders?.(server);
      const headers = { ...(injectedHeaders ?? {}) };
      transport = new SSEClientTransport(new URL(url), Object.keys(headers).length > 0
        ? {
          // The initial SSE request goes through this fetch, and every message
          // POST through `requestInit`; a credential has to ride both legs, so
          // both are supplied rather than only the one the SDK documents first.
          eventSourceInit: {
            fetch: ((input: string | URL | Request, init?: RequestInit) => globalThis.fetch(input, {
              ...init,
              headers: { ...(init?.headers as Record<string, string> | undefined), ...headers },
            })) as typeof fetch,
          },
          requestInit: { headers },
        }
        : undefined);
    }

    const client = new Client({ name: 'sandbase-harness', version: '1.0.0' });
    try {
      await client.connect(transport);
    } finally {
      // The resolver's records were needed only to establish the connection, so
      // they are emptied here: the manager keeps no credential material for the
      // rest of the session, and a reconnect resolves it again through the same
      // option. The copies handed to a transport belong to that transport.
      clearInjectedValues(injectedEnv);
      clearInjectedValues(injectedHeaders);
    }

    return {
      async tools() {
        const { tools } = await client.listTools();
        return Object.fromEntries(tools.map((tool) => [tool.name, {
          description: tool.description,
          parameters: tool.inputSchema,
          execute: (args: unknown) =>
            client.callTool({ name: tool.name, arguments: (args ?? {}) as Record<string, unknown> }),
        }]));
      },
      close: () => client.close(),
    };
  }
}

// ============================================================
// Helpers
// ============================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Empty a record a credential resolver handed over.
 *
 * The record is the manager's copy for one connect attempt, so it is cleared
 * rather than left reachable from a long-lived object.
 */
function clearInjectedValues(values?: Record<string, string>): void {
  if (!values) return;
  for (const key of Object.keys(values)) delete values[key];
}

/** Heuristic: does this error indicate a dropped/broken MCP connection? */
function isConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message.toLowerCase();
  return (
    m.includes('closed') ||
    m.includes('disconnect') ||
    m.includes('econnreset') ||
    m.includes('epipe') ||
    m.includes('socket') ||
    m.includes('not connected') ||
    m.includes('transport') ||
    m.includes('terminated')
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  // Clear the timer whichever way the race settles, so a resolved connect
  // doesn't leave a dangling timer keeping the event loop alive.
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
