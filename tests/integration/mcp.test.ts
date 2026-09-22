/**
 * Integration test: MCP client integration (Requirement 5).
 *
 * Verifies:
 * - stdio MCP server tools are discovered and namespaced
 * - degraded mode: a server that fails to connect is skipped, not fatal (R5.5)
 * - empty config → empty tool set
 * - close() tears down connections
 */

import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { McpManager, reconnectDelay } from '@/core/mcp/mcp-manager.js';
import { Database } from '@/core/db/database.js';
import { encryptSecret } from '@/core/security/secrets.js';
import { resolveSessionCredentialInjections } from '@/core/credentials/injection.js';
import { ToolResolver } from '@/core/session/tool-resolver.js';
import type { McpServerConfig, AgentDefinition } from '@/types/agent.js';
import type { Session } from '@/types/session.js';
import type { SandboxInstance } from '@/types/sandbox.js';

const MOCK_SERVER = join(import.meta.dirname, '../fixtures/mock-mcp-server.mjs');
const CREDENTIAL_SERVER = join(import.meta.dirname, '../fixtures/credential-mcp-server.mjs');

describe('MCP integration', () => {
  let manager: McpManager;

  afterEach(async () => {
    if (manager) await manager.close();
  });

  it('returns empty tools for empty server list', async () => {
    manager = new McpManager();
    const tools = await manager.connectAll([]);
    expect(Object.keys(tools)).toHaveLength(0);
  });

  it('discovers and namespaces tools from a stdio MCP server', async () => {
    manager = new McpManager();
    const servers: McpServerConfig[] = [
      { name: 'mock', type: 'stdio', command: 'node', args: [MOCK_SERVER] },
    ];
    const tools = await manager.connectAll(servers);

    // Tool should be namespaced mcp_<server>_<tool>
    expect(tools['mcp_mock_echo']).toBeDefined();

    const statuses = manager.getStatuses();
    expect(statuses).toHaveLength(1);
    expect(statuses[0].connected).toBe(true);
    expect(statuses[0].toolCount).toBe(1);
  });

  it('degrades gracefully when a server fails to connect (R5.5)', async () => {
    manager = new McpManager();
    const servers: McpServerConfig[] = [
      { name: 'broken', type: 'stdio', command: 'this-command-does-not-exist-xyz', args: [], timeout: 3 },
    ];
    // Must NOT throw
    const tools = await manager.connectAll(servers);
    expect(Object.keys(tools)).toHaveLength(0);

    const statuses = manager.getStatuses();
    expect(statuses[0].connected).toBe(false);
    expect(statuses[0].error).toBeTruthy();
  });

  it('keeps working servers when one fails (partial degradation)', async () => {
    manager = new McpManager();
    const servers: McpServerConfig[] = [
      { name: 'broken', type: 'stdio', command: 'nonexistent-xyz', args: [], timeout: 3 },
      { name: 'mock', type: 'stdio', command: 'node', args: [MOCK_SERVER] },
    ];
    const tools = await manager.connectAll(servers);

    // The good server's tool is present despite the broken one
    expect(tools['mcp_mock_echo']).toBeDefined();

    const statuses = manager.getStatuses();
    expect(statuses.find((s) => s.name === 'broken')!.connected).toBe(false);
    expect(statuses.find((s) => s.name === 'mock')!.connected).toBe(true);
  });

  it('rejects stdio config missing command / http config missing url', async () => {
    manager = new McpManager();
    const tools = await manager.connectAll([
      { name: 'bad-stdio', type: 'stdio' } as McpServerConfig,
      { name: 'bad-http', type: 'url' } as McpServerConfig,
    ]);
    expect(Object.keys(tools)).toHaveLength(0);
    const statuses = manager.getStatuses();
    expect(statuses.every((s) => !s.connected)).toBe(true);
  });

  describe('reconnect backoff (R5.6)', () => {
    it('uses exponential backoff capped at 60s', () => {
      expect(reconnectDelay(0)).toBe(1000);
      expect(reconnectDelay(1)).toBe(2000);
      expect(reconnectDelay(2)).toBe(4000);
      expect(reconnectDelay(3)).toBe(8000);
      expect(reconnectDelay(4)).toBe(16000);
      expect(reconnectDelay(10)).toBe(60000); // capped
    });

    it('reconnects a known server and re-registers its tools', async () => {
      manager = new McpManager();
      // First connect the mock server
      await manager.connectAll([
        { name: 'mock', type: 'stdio', command: 'node', args: [MOCK_SERVER] },
      ]);

      // Simulate a reconnect (no real drop; verifies the reconnect path works)
      const delays: number[] = [];
      const tools = await manager.reconnect('mock', async (ms) => { delays.push(ms); });
      expect(tools).not.toBeNull();
      expect(tools!['mcp_mock_echo']).toBeDefined();
    });

    it('returns null for an unknown server', async () => {
      manager = new McpManager();
      const tools = await manager.reconnect('nonexistent', async () => {});
      expect(tools).toBeNull();
    });

    it('auto-reconnects and retries a tool call when the connection drops (L5)', async () => {
      manager = new McpManager();
      manager.setSleepFn(async () => {}); // no real backoff sleeps in test
      const tools = await manager.connectAll([
        { name: 'mock', type: 'stdio', command: 'node', args: [MOCK_SERVER] },
      ]);

      const echo = tools['mcp_mock_echo'] as { execute: (a: any) => Promise<any> };
      expect(echo).toBeDefined();

      // Monkey-patch the live tool to throw a connection error on first call,
      // then succeed — the wrapper should reconnect and retry transparently.
      const live = (manager as any).liveTools.get('mock');
      const original = live.echo.execute;
      let calls = 0;
      live.echo.execute = async (args: any) => {
        calls++;
        if (calls === 1) throw new Error('socket closed');
        return original(args);
      };

      const result = await echo.execute({ text: 'hi' });
      // After reconnect, the fresh tool executes normally
      expect(JSON.stringify(result)).toContain('echo: hi');
    });

    it('retries with backoff then gives up on a permanently-broken server', async () => {
      manager = new McpManager();
      await manager.connectAll([
        { name: 'broken', type: 'stdio', command: 'nonexistent-xyz', args: [], timeout: 1 },
      ]);
      const delays: number[] = [];
      const tools = await manager.reconnect('broken', async (ms) => { delays.push(ms); });
      expect(tools).toBeNull();
      // 5 attempts → 4 backoff sleeps between them: 1s,2s,4s,8s
      expect(delays).toEqual([1000, 2000, 4000, 8000]);
      const status = manager.getStatuses().find((s) => s.name === 'broken');
      expect(status!.connected).toBe(false);
    }, 15_000);
  });

  /**
   * The transport half of the credential contract: a session's Vault material
   * reaches the MCP server it declares, and the value does not reach the model.
   *
   * `contracts/anthropic-cma/credentials.md` §6 cites this file for the
   * behaviour. A stdio server can only read it from its own process
   * environment, so the assertion comes from a real subprocess reporting what it
   * was started with rather than from a stub that would prove nothing.
   */
  describe('vault credential transport', () => {
    const SECRET = 'mcp-vault-demo-secret';
    const AGENT_VALUE = 'agent-configured-value';
    const resolvers: ToolResolver[] = [];
    let db: Database | undefined;
    let tmpDir: string | undefined;
    let session: Session;

    afterEach(async () => {
      for (const resolver of resolvers.splice(0)) await resolver.cleanupSession(session.id);
      db?.close();
      db = undefined;
      if (tmpDir) {
        rmSync(tmpDir, { recursive: true, force: true });
        tmpDir = undefined;
      }
    });

    /** A running session that attaches a vault holding one environment credential. */
    function setupVault(network: Record<string, unknown>): void {
      tmpDir = mkdtempSync(join(tmpdir(), 'ma-mcp-vault-'));
      db = new Database(join(tmpDir, 'test.db'));
      db.runMigrations();
      db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_mcp', 'local', '{}')`);
      db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_mcp', 'mcp-agent', '{}')`);
      db.exec(`INSERT INTO credential_vaults (id, name) VALUES ('vlt_mcp', 'MCP vault')`);
      db.exec(`INSERT INTO sessions (id, agent_id, agent_name, environment_id, status, vault_ids) VALUES ('sess_mcp_vault', 'agent_mcp', 'mcp-agent', 'env_mcp', 'running', '["vlt_mcp"]')`);
      const encrypted = encryptSecret(SECRET, tmpDir);
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO credential_records (
          id, vault_id, name, auth_type, variable_name, value_hint, network,
          injection_locations, secret_ciphertext, secret_nonce, secret_tag, status, metadata, created_at, updated_at
        ) VALUES ('crd_mcp', 'vlt_mcp', 'MCP token', 'environment_variable', 'TOKEN', '••••cret', ?, '[]', ?, ?, ?, 'active', '{}', ?, ?)`,
      ).run(JSON.stringify(network), encrypted.ciphertext, encrypted.nonce, encrypted.tag, now, now);
      session = {
        id: 'sess_mcp_vault',
        agentId: 'agent_mcp',
        agentName: 'mcp-agent',
        environmentId: 'env_mcp',
        status: 'running',
        vaultIds: ['vlt_mcp'],
        createdAt: new Date(),
        updatedAt: new Date(),
      } as unknown as Session;
    }

    /** Resolve the tool map the way a turn does: real resolver, real stdio server. */
    async function resolveTools(): Promise<Record<string, any>> {
      const agent = {
        name: 'mcp-agent',
        model: 'gpt-4o-mini',
        system: 'use the vault',
        mcp_servers: [{
          name: 'credential',
          type: 'stdio',
          command: 'node',
          args: [CREDENTIAL_SERVER],
          // A value the agent configures itself: the Vault credential is the
          // operator's, so it has to win rather than merge.
          env: { TOKEN: AGENT_VALUE },
        }],
        tools: [{
          type: 'mcp_toolset',
          mcp_server_name: 'credential',
          default_config: { permission_policy: { type: 'always_allow' } },
        }],
      } as unknown as AgentDefinition;
      const resolver = new ToolResolver({
        delegationService: { buildDelegationTools: () => ({}) } as never,
        resolveCredentialInjections: (sessionId, targetHost) => resolveSessionCredentialInjections(db!, sessionId, {
          dataDir: tmpDir,
          targetHost,
        }),
      });
      resolvers.push(resolver);
      const sandbox = {
        async writeFile() {},
        async readFile() { return ''; },
        async listFiles() { return []; },
        async execute() { return { exitCode: 0, stdout: '', stderr: '' }; },
        async destroy() {},
      } as unknown as SandboxInstance;
      return await resolver.resolveTools(session, agent, sandbox) as Record<string, any>;
    }

    it('starts a stdio server with the session vault environment and keeps the value out of the result', async () => {
      setupVault({ type: 'unrestricted', allowed_hosts: [] });
      const tools = await resolveTools();

      const result = await tools['mcp_credential_echo_env'].execute({});

      // The subprocess reports the value it was actually started with…
      expect(JSON.stringify(result)).toContain('TOKEN=[REDACTED]');
      // …which is the Vault's rather than the agent's…
      expect(JSON.stringify(result)).not.toContain(AGENT_VALUE);
      // …and the secret itself never reaches the strategy.
      expect(JSON.stringify(result)).not.toContain(SECRET);
    });

    it('leaves a credential the network policy denies out of the server environment', async () => {
      setupVault({ type: 'limited', allowed_hosts: ['api.example.com'] });
      const tools = await resolveTools();

      const result = await tools['mcp_credential_echo_env'].execute();

      // A credential with no authorized host is refused here exactly as it is
      // for a shell command, so the server runs on the agent's own value.
      expect(JSON.stringify(result)).toContain(`TOKEN=${AGENT_VALUE}`);
      expect(JSON.stringify(result)).not.toContain(SECRET);
      const actions = db!.prepare('SELECT action FROM credential_audit_events').all() as { action: string }[];
      expect(actions.map((row) => row.action)).toContain('runtime_denied');
    });
  });
});
