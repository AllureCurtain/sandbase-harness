/**
 * Integration test: a session's vault credentials reach its sandbox commands.
 *
 * The reviewed snapshot carried exactly this case and nothing else: the executor
 * resolves the session's vault, the bash tool runs with the injected environment,
 * the string the strategy sees is redacted, and no persisted event carries the
 * secret. `resolveSessionCredentialInjections` and `createCredentialRedactor`
 * already existed and were unit-tested; what this asserts is the wiring between
 * them and `DefaultSessionExecutor`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { encryptSecret } from '@/core/security/secrets.js';
import { resolveSessionCredentialInjections } from '@/core/credentials/injection.js';
import { EventLogger } from '@/core/session/event-logger.js';
import { DefaultSessionExecutor } from '@/core/session/executor.js';
import { ModelRegistry } from '@/model/registry.js';
import { sandboxCapabilities, type SandboxInstance, type SandboxProvider } from '@/types/sandbox.js';
import type { AgentDefinition } from '@/types/agent.js';
import type { AgentStrategy } from '@/types/strategy.js';
import type { Session } from '@/types/session.js';

const SECRET = 'executor-demo-secret';

describe('credential execution wiring', () => {
  let db: Database | undefined;
  let tmpDir: string | undefined;

  afterEach(() => {
    db?.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves the vault in DefaultSessionExecutor, injects bash env, and redacts event payloads', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-credential-execution-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_test', 'local', '{}')`);
    db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_test', 'credential-agent', '{}')`);
    db.exec(`INSERT INTO credential_vaults (id, name) VALUES ('vlt_exec', 'execution vault')`);
    db.exec(`INSERT INTO sessions (id, agent_id, agent_name, environment_id, status, vault_ids) VALUES ('sess_exec', 'agent_test', 'credential-agent', 'env_test', 'running', '["vlt_exec"]')`);
    const encrypted = encryptSecret(SECRET, tmpDir);
    db.prepare(
      `INSERT INTO credential_records (
        id, vault_id, name, auth_type, variable_name, value_hint, network,
        injection_locations, secret_ciphertext, secret_nonce, secret_tag, status, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, 'environment_variable', 'TOKEN', '••••cret', ?, '[]', ?, ?, ?, 'active', '{}', ?, ?)`,
    ).run(
      'crd_exec', 'vlt_exec', 'token', JSON.stringify({ type: 'unrestricted', allowed_hosts: [] }),
      encrypted.ciphertext, encrypted.nonce, encrypted.tag, new Date().toISOString(), new Date().toISOString(),
    );

    let executeOptions: Record<string, unknown> | undefined;
    let observedOutput = '';
    const sandbox: SandboxInstance = {
      sessionId: 'sess_exec',
      async execute(_command, options) {
        executeOptions = options as Record<string, unknown>;
        return { exitCode: 0, stdout: `TOKEN=${SECRET}`, stderr: '', timedOut: false };
      },
      async writeFile() {},
      async readFile() { return ''; },
      async listFiles() { return []; },
      async cleanup() {},
    };
    const provider: SandboxProvider = {
      type: 'local',
      capabilities: sandboxCapabilities(),
      async provision() { return sandbox; },
    };
    const agent: AgentDefinition = {
      name: 'credential-agent', model: 'm', system: 'test',
      tools: [{
        type: 'agent_toolset_20260401',
        default_config: { enabled: true, permission_policy: { type: 'always_allow' } },
        configs: [{ name: 'bash', enabled: true }],
      }],
    };
    const strategy: AgentStrategy = {
      name: 'credential-test',
      requiresModel: false,
      async *execute(context) {
        observedOutput = await context.tools.bash.execute!({ command: 'echo $TOKEN' }) as string;
        context.eventLog.append(context.session.id, {
          type: 'agent.tool_result',
          content: [{ type: 'tool_result', tool_use_id: 'tool_exec', content: observedOutput }],
        });
      },
    };
    const modelRegistry = new ModelRegistry();
    modelRegistry.register({ name: 'm', provider: 'openai', model: 'm', is_default: true });
    const executor = new DefaultSessionExecutor({
      agents: [agent],
      modelRegistry,
      sandboxProvider: provider,
      resolveEnvironmentConfig: () => ({ name: 'local', sandbox_provider: 'local' }),
      strategy,
      eventLogger: new EventLogger(db),
      resolveCredentialInjections: (sessionId, targetHost) => resolveSessionCredentialInjections(db!, sessionId, {
        dataDir: tmpDir,
        targetHost,
      }),
    });
    const session: Session = {
      id: 'sess_exec', agentId: 'agent_test', agentName: agent.name, agentDefinition: agent,
      environmentId: 'env_test', status: 'running', vaultIds: ['vlt_exec'],
      createdAt: new Date(), updatedAt: new Date(),
    };

    for await (const _event of executor.execute(session, { type: 'user.message', content: [{ type: 'text', text: 'run it' }] })) {
      // drain
    }

    expect(executeOptions).toEqual({ env: { TOKEN: SECRET } });
    expect(observedOutput).toBe(`TOKEN=${SECRET}`.replace(SECRET, '[REDACTED]'));
    const events = new EventLogger(db).getEvents(session.id);
    expect(JSON.stringify(events)).not.toContain(SECRET);
    await executor.cleanupSession(session.id);
  });
});
