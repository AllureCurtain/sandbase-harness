import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '@/core/db/database.js';
import { PiStrategy } from '@/strategy/pi-strategy.js';
import { PiLauncher } from '@/strategy/pi-launcher.js';
import {
  PI_POLICY_MISMATCH_CODE,
  PiContinuityError,
  getPiSessionState,
  recordPiSessionState,
} from '@/strategy/pi/session-continuity.js';
import type {
  LoopEngineSession,
  LoopEngineSteerInput,
  LoopEngineSteerReceipt,
  LoopEngineTurnOutcome,
} from '@/strategy/loop-engine/adapter.js';
import type { SessionEvent } from '@/types/session.js';
import type { StrategyContext } from '@/types/strategy.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/**
 * A workspace with one Pi session whose conversation already ran under a
 * recorded contract.
 *
 * Recorded through `recordPiSessionState` rather than by hand, so the row is the
 * one the runtime itself would have written after a settled turn: a managed
 * session file with a valid header, plus the work directory and policy
 * fingerprint those turns ran under.
 */
function recordedWorkspace(prefix: string, workDir: string, policyFingerprint: string) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  const db = new Database(join(directory, 'data.db'));
  db.runMigrations();
  db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
  db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_pi', 'pi-agent', '{}')`);
  const sessionId = 'sess_pi_bound';
  db.exec(`INSERT INTO sessions (id, agent_id, agent_name, environment_id, status, resources, vault_ids, loop_engine) VALUES ('${sessionId}', 'agent_pi', 'pi-agent', 'env_default', 'paused', '[]', '[]', 'pi')`);
  const sessionFile = join(directory, 'pi-sessions', `${sessionId}.jsonl`);
  mkdirSync(join(directory, 'pi-sessions'), { recursive: true });
  writeFileSync(sessionFile, '{"type":"session","id":"pi-bound","version":1}\n');
  recordPiSessionState(
    db,
    sessionId,
    sessionFile,
    { id: 'pi-bound', schemaVersion: '1' },
    'active',
    undefined,
    { workDir, policyFingerprint },
  );
  return { db, directory, sessionId, sessionFile };
}

/**
 * A launcher whose child is never supposed to start.
 *
 * A refused resume must be decided before a process exists, so a spawn attempt is
 * a failure of the guard itself rather than a detail of the test.
 */
function nonSpawningLauncher(directory: string, db: Database, attempts: string[]): PiLauncher {
  return new PiLauncher({
    dataDir: directory,
    database: db,
    command: 'controlled-pi',
    spawnImpl: ((...args: unknown[]) => {
      attempts.push(String(args[0]));
      throw new Error('a refused resume must not spawn a child');
    }) as unknown as typeof import('node:child_process').spawn,
  });
}

/**
 * A controlled RPC child that starts and stays alive.
 *
 * The binding only refuses a mismatch; a resume that may continue has to reach a
 * real spawn, so the legacy case needs a child that behaves like Pi's RPC mode —
 * it never exits on its own and holds its work directory until it is killed.
 */
function controlledRpcChild(directory: string): { command: string; commandArgs: string[]; startedPath: string } {
  const script = join(directory, 'controlled-rpc-pi.mjs');
  const startedPath = join(directory, 'rpc-started.json');
  writeFileSync(script, `
import { writeFileSync } from 'node:fs';
const [startedPath] = process.argv.slice(2);
writeFileSync(startedPath, JSON.stringify({ cwd: process.cwd() }));
setInterval(() => {}, 1_000);
`);
  return { command: process.execPath, commandArgs: [script, startedPath], startedPath };
}

/**
 * A child that exited because Pi refused to resume its stored session.
 *
 * Pi reports this on stderr and exits immediately, and the session owner turns
 * it into a continuity failure rather than a bare "stdout ended" — the two call
 * for opposite responses, so the distinction has to survive into the strategy,
 * which is what records it durably.
 */
class ResumedRefusalSession implements LoopEngineSession {
  readonly calls: string[] = [];
  alive = true;
  phase: 'idle' | 'busy' | 'closed' = 'idle';
  turnId: string | undefined = 'piturn_1';
  stderrTail = 'Stored session working directory does not exist';
  engineSessionFile: string;
  failureError: Error | undefined;

  constructor(readonly sessionId: string, sessionFile: string) {
    this.engineSessionFile = sessionFile;
  }

  async prompt(): Promise<void> {
    this.calls.push('prompt');
  }

  async awaitTurnOutcome(): Promise<LoopEngineTurnOutcome> {
    return {
      kind: 'failed',
      error: new PiContinuityError('pi_resume_refused', `Pi refused to resume the stored session: ${this.stderrTail}`),
    };
  }

  async respondToInteraction(): Promise<boolean> {
    return false;
  }

  /** No live turn accepts steering in this scenario; the session reports that. */
  async steer(input: LoopEngineSteerInput): Promise<LoopEngineSteerReceipt> {
    return { inputId: input.inputId, state: 'rejected', detail: 'no turn is accepting steering' };
  }

  closeSteerAdmission(): void {
    this.calls.push('closeSteerAdmission');
  }

  async settleSteerReceipts(): Promise<void> {
    this.calls.push('settleSteerReceipts');
  }

  async interrupt(): Promise<void> {
    this.alive = false;
    this.phase = 'closed';
  }

  async close(): Promise<void> {
    this.alive = false;
    this.phase = 'closed';
  }
}

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

    const session = new ResumedRefusalSession(sessionId, sessionFile);
    const strategy = new PiStrategy({
      adapter: { async startSession() { return session; } },
      database: db,
    });
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
        append: (_id: string, event: { type: string }) => ({ id: 'sevt_1', sessionId, seq: 1, type: event.type, createdAt: new Date() } as SessionEvent),
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

  it('refuses a resume whose work directory changed, without starting a child', async () => {
    const recordedRoot = mkdtempSync(join(tmpdir(), 'ma-pi-bound-work-'));
    const elsewhereRoot = mkdtempSync(join(tmpdir(), 'ma-pi-other-work-'));
    directories.push(recordedRoot, elsewhereRoot);
    const recorded = join(recordedRoot, 'work');
    const elsewhere = join(elsewhereRoot, 'work');
    const value = recordedWorkspace('ma-pi-bound-', recorded, 'fingerprint-recorded');
    const attempts: string[] = [];
    const launcher = nonSpawningLauncher(value.directory, value.db, attempts);

    // The session file still proves which conversation this is; what changed is
    // the contract it would be continued under.
    await expect(launcher.startRpc({
      sessionId: value.sessionId,
      workDir: elsewhere,
      systemPrompt: 'system',
      model: { provider: 'openai', model: 'fixture-model', api_key: 'fixture-key' },
      policyFingerprint: 'fingerprint-recorded',
    })).rejects.toMatchObject({
      code: PI_POLICY_MISMATCH_CODE,
      message: expect.stringContaining('work directory'),
    });

    // Nothing was spawned, and the refusal is durable so the next attempt reads
    // it instead of rediscovering it — and cannot fall through to a fork.
    expect(attempts).toEqual([]);
    expect(getPiSessionState(value.db, value.sessionId)).toMatchObject({ status: PI_POLICY_MISMATCH_CODE });
    await expect(launcher.startRpc({
      sessionId: value.sessionId,
      workDir: elsewhere,
      systemPrompt: 'system',
      model: { provider: 'openai', model: 'fixture-model', api_key: 'fixture-key' },
      policyFingerprint: 'fingerprint-recorded',
    })).rejects.toMatchObject({ code: 'pi_session_discontinuous' });
    expect(attempts).toEqual([]);
    value.db.close();
  });

  it('refuses a resume whose compiled policy changed and names the policy, not the directory', async () => {
    const workRoot = mkdtempSync(join(tmpdir(), 'ma-pi-same-work-'));
    directories.push(workRoot);
    const workDir = join(workRoot, 'work');
    const value = recordedWorkspace('ma-pi-policy-drift-', workDir, 'fingerprint-recorded');
    const attempts: string[] = [];
    const launcher = nonSpawningLauncher(value.directory, value.db, attempts);

    // Same directory, different contract: the refusal has to name the half that
    // drifted, or an operator repairs the directory that never changed.
    await expect(launcher.startRpc({
      sessionId: value.sessionId,
      workDir,
      systemPrompt: 'system',
      model: { provider: 'openai', model: 'fixture-model', api_key: 'fixture-key' },
      policyFingerprint: 'fingerprint-after-a-policy-change',
    })).rejects.toMatchObject({
      code: PI_POLICY_MISMATCH_CODE,
      message: expect.stringContaining('tool policy'),
    });

    expect(attempts).toEqual([]);
    expect(getPiSessionState(value.db, value.sessionId)).toMatchObject({ status: PI_POLICY_MISMATCH_CODE });
    value.db.close();
  });

  it('resumes a session recorded before the binding existed, which has nothing to compare', async () => {
    const value = recordedWorkspace('ma-pi-legacy-row-', join(tmpdir(), 'not-the-recorded-dir'), 'fingerprint-recorded');
    // The exact shape a pre-M041 row has: identity and status, no binding at all.
    value.db.prepare(`
      UPDATE pi_session_state SET work_dir = NULL, policy_fingerprint = NULL WHERE session_id = ?
    `).run(value.sessionId);

    const child = controlledRpcChild(value.directory);
    const launcher = new PiLauncher({
      dataDir: value.directory,
      database: value.db,
      command: child.command,
      commandArgs: child.commandArgs,
      terminateProcess: (piChild, _platform, force) => {
        piChild.kill(force ? 'SIGKILL' : 'SIGTERM');
      },
    });

    // A row with no recorded binding has nothing to disagree with, so the resume
    // proceeds: an upgrade must not refuse every session it inherited.
    const handle = await launcher.startRpc({
      sessionId: value.sessionId,
      workDir: value.directory,
      systemPrompt: 'system',
      model: { provider: 'openai', model: 'fixture-model', api_key: 'fixture-key' },
      policyFingerprint: 'fingerprint-this-runtime-compiled',
    });
    expect(handle.sessionFile).toBe(value.sessionFile);
    await handle.interrupt();
    expect(getPiSessionState(value.db, value.sessionId)).toMatchObject({ status: 'active' });
    value.db.close();
  });
});
