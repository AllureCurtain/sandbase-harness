import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import { DefaultSessionExecutor } from '@/core/session/executor.js';
import { SandboxLifecycle } from '@/core/session/sandbox-lifecycle.js';
import { ModelRegistry } from '@/model/registry.js';
import { LocalSandboxProvider } from '@/sandbox/local-provider.js';
import { sandboxCapabilities, type SandboxInstance, type SandboxProvider } from '@/types/sandbox.js';
import type { AgentStrategy, StrategyContext } from '@/types/strategy.js';
import type { LanguageModel } from 'ai';

function fakeModel(): LanguageModel {
  return {
    specificationVersion: 'v4', provider: 'test', modelId: 't', supportedUrls: {},
    async doGenerate() {
      return { content: [], finishReason: { unified: 'stop', raw: 'stop' }, usage: {}, warnings: [] } as any;
    },
    async doStream() { throw new Error('unused'); },
  } as unknown as LanguageModel;
}

function session(id: string, resources: Array<Record<string, unknown>> = []) {
  return {
    id,
    agentId: 'agent_resources',
    agentName: 'resources',
    environmentId: 'env_default',
    status: 'running' as const,
    resources,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function waitForPaused(manager: SessionManager, id: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (manager.get(id)?.status === 'paused') return resolve();
      if (Date.now() >= deadline) return reject(new Error(`session ${id} did not finish`));
      setTimeout(poll, 10);
    };
    poll();
  });
}

class PromptStrategy implements AgentStrategy {
  readonly name = 'prompt-capture';
  prompts: string[] = [];

  // eslint-disable-next-line require-yield
  async *execute(context: StrategyContext) {
    this.prompts.push(context.systemPrompt);
    return;
  }
}

describe('session resource execution closure', () => {
  it('writes file resources after snapshot restore and only once per bound sandbox', async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const restoreOrder: string[] = [];
    let provisions = 0;
    const sandbox: SandboxInstance = {
      ...minimalSandbox('sess_file'),
      hostWorkDir: '/tmp/sess_file',
      async writeFile(path, content) {
        writes.push({ path, content: content.toString() });
      },
    };
    const provider: SandboxProvider = {
      type: 'local',
      capabilities: sandboxCapabilities({ hostFilesystem: true }),
      async provision() {
        provisions += 1;
        return sandbox;
      },
    };
    const lifecycle = new SandboxLifecycle({
      sandboxProvider: provider,
      snapshots: { restoreLatest: () => { restoreOrder.push('restore'); } } as never,
      resolveEnvironmentConfig: () => ({ name: 'local', sandbox_provider: 'local', timeout: 300, snapshot: { enabled: true } }),
      fileArtifactReader: async (fileId) => {
        restoreOrder.push(`read:${fileId}`);
        return Buffer.from('uploaded bytes');
      },
    });

    const resourceSession = session('sess_file', [{ type: 'file', file_id: 'file_input', mount_path: '/notes/input.txt' }]);
    await lifecycle.getOrProvision(resourceSession);
    await lifecycle.getOrProvision(resourceSession);

    expect(provisions).toBe(1);
    expect(restoreOrder).toEqual(['restore', 'read:file_input']);
    // The canonical `/notes/input.txt` maps under the session upload root with
    // its nested layout intact.
    expect(writes).toEqual([{ path: '/mnt/session/uploads/notes/input.txt', content: 'uploaded bytes' }]);
  });

  it('still materializes a file resource stored with the legacy internal path', async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const sandbox: SandboxInstance = {
      ...minimalSandbox('sess_legacy'),
      async writeFile(path, content) {
        writes.push({ path, content: content.toString() });
      },
    };
    const lifecycle = new SandboxLifecycle({
      sandboxProvider: {
        type: 'local',
        capabilities: sandboxCapabilities(),
        async provision() { return sandbox; },
      },
      fileArtifactReader: async () => Buffer.from('legacy bytes'),
    });

    const legacySession = session('sess_legacy', [{ type: 'file', file_id: 'file_input', mount_path: '/uploads/input.txt' }]);
    await lifecycle.getOrProvision(legacySession);

    // A pre-canonical row keeps working: the internal prefix is not applied twice.
    expect(writes).toEqual([{ path: '/mnt/session/uploads/input.txt', content: 'legacy bytes' }]);
  });

  it('rejects traversal mount paths and cleans a failed provision', async () => {
    let cleanupCount = 0;
    const sandbox: SandboxInstance = {
      ...minimalSandbox('sess_bad_path'),
      async cleanup() { cleanupCount += 1; },
    };
    const provider: SandboxProvider = {
      type: 'local',
      capabilities: sandboxCapabilities(),
      async provision() { return sandbox; },
    };
    const lifecycle = new SandboxLifecycle({
      sandboxProvider: provider,
      fileArtifactReader: () => Buffer.from('x'),
    });

    await expect(lifecycle.getOrProvision(session('sess_bad_path', [
      { type: 'file', file_id: 'file_x', mount_path: '/uploads/../escape.txt' },
    ]))).rejects.toThrow(/mount_path/);
    expect(cleanupCount).toBe(1);
  });
});

function minimalSandbox(sessionId: string): SandboxInstance {
  return {
    sessionId,
    async execute() { return { exitCode: 0, stdout: '', stderr: '', timedOut: false }; },
    async writeFile() {},
    async readFile() { return ''; },
    async listFiles() { return []; },
    async cleanup() {},
  };
}
