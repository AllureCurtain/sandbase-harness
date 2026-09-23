import { Readable } from 'node:stream';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '@/core/db/database.js';
import { PiStrategy } from '@/strategy/pi-strategy.js';
import { recordPiSessionState, getPiSessionState } from '@/strategy/pi/session-continuity.js';
import type { StrategyContext } from '@/types/strategy.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('Pi resume refusal', () => {
  it('makes a Pi resume refusal visible and records continuity failure state', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ma-pi-resume-refused-'));
    directories.push(directory);
    const db = new Database(join(directory, 'data.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_pi', 'pi-agent', '{}')`);
    const sessionId = 'sess_pi_resume';
    db.exec(`INSERT INTO sessions (id, agent_id, agent_name, environment_id, status, resources, vault_ids, loop_engine) VALUES ('${sessionId}', 'agent_pi', 'pi-agent', 'env_default', 'paused', '[]', '[]', 'pi')`);
    const sessionFile = join(directory, 'pi-sessions', `${sessionId}.jsonl`);
    mkdirSync(join(directory, 'pi-sessions'), { recursive: true });
    writeFileSync(sessionFile, '{"type":"session","id":"pi-resume","version":1}\n');
    recordPiSessionState(db, sessionId, sessionFile, { id: 'pi-resume', schemaVersion: '1' });

    const strategy = new PiStrategy({
      async launch() {},
      async start() {
        return {
          child: {} as any,
          sessionFile,
          stdout: Readable.from(['{"type":"session","id":"pi-resume"}\n']),
          stderr: Readable.from(['Stored session working directory does not exist\n']),
          wait: async () => ({ code: 1, signal: null }),
          terminate: async () => {},
        };
      },
    }, db);
    const context = {
      session: {
        id: sessionId, loopEngine: 'pi', agentId: 'agent_pi', agentName: 'pi-agent',
        environmentId: 'env_default', status: 'running', createdAt: new Date(), updatedAt: new Date(),
        // The launch compiles the session's tool flags from this frozen
        // definition; the executor always sets it before a strategy runs, so the
        // resume refusal below is what this turn has left to report.
        agentDefinition: {
          name: 'pi-agent',
          model: 'fixture-model',
          system: 'system',
          tools: [{ type: 'agent_toolset_20260401', configs: [{ name: 'read' }] }],
        },
      },
      userEvent: { type: 'user.message', content: [{ type: 'text', text: 'resume' }] },
      systemPrompt: 'system', messages: [],
      modelConfig: { name: 'fixture', provider: 'openai', model: 'fixture-model', api_key: 'fixture-key' },
      tools: {}, sandbox: { sessionId, hostWorkDir: directory }, eventLog: {
        append: (_id: string, event: any) => ({ id: 'sevt_1', sessionId, seq: 1, type: event.type, content: event.content, createdAt: new Date() } as any),
        getLatestSeq: () => 0,
        recordUsage: () => {},
      }, broadcast: () => {}, config: {},
    } as unknown as StrategyContext;

    const run = async () => {
      for await (const _event of strategy.execute(context)) {}
    };
    await expect(run()).rejects.toMatchObject({ code: 'pi_resume_refused' });
    expect(getPiSessionState(db, sessionId)).toMatchObject({ status: 'pi_resume_refused' });
    db.close();
  });
});
