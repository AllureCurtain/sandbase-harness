import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '@/core/db/database.js';
import {
  assertPiSessionContinuity,
  getPiSessionState,
  inspectPiSessionFile,
  recordPiSessionState,
} from '@/strategy/pi/session-continuity.js';
import { PiLauncher } from '@/strategy/pi-launcher.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'ma-pi-continuity-'));
  directories.push(directory);
  const db = new Database(join(directory, 'data.db'));
  db.runMigrations();
  db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
  db.exec(`INSERT INTO agents (id, name, definition) VALUES ('agent_pi', 'pi-agent', '{}')`);
  const session = 'sess_pi_continuity';
  db.exec(`INSERT INTO sessions (id, agent_id, agent_name, environment_id, status, resources, vault_ids, loop_engine) VALUES ('${session}', 'agent_pi', 'pi-agent', 'env_default', 'paused', '[]', '[]', 'pi')`);
  return { db, directory, session, file: join(directory, 'session.jsonl') };
}

describe('Pi session continuity state', () => {
  it('accepts a new empty file, then requires matching SQLite state for resume', () => {
    const value = setup();
    writeFileSync(value.file, '');
    expect(assertPiSessionContinuity(value.db, value.session, value.file)).toEqual({});

    writeFileSync(value.file, '{"type":"session","id":"pi-1","version":1}\n');
    expect(() => assertPiSessionContinuity(value.db, value.session, value.file)).toThrow('without matching SandBase continuity state');
    recordPiSessionState(value.db, value.session, value.file, { id: 'pi-1', schemaVersion: '1' });
    expect(assertPiSessionContinuity(value.db, value.session, value.file).state).toMatchObject({ piSessionId: 'pi-1', schemaVersion: '1', status: 'active' });
    expect(getPiSessionState(value.db, value.session)?.sessionFile).toBe(value.file);
    value.db.close();
  });

  it('rejects a changed header identity, schema, and malformed header', () => {
    const value = setup();
    writeFileSync(value.file, '{"type":"session","id":"pi-1","version":1}\n');
    recordPiSessionState(value.db, value.session, value.file, { id: 'pi-1', schemaVersion: '1' });

    writeFileSync(value.file, '{"type":"session","id":"pi-2","version":1}\n');
    expect(() => assertPiSessionContinuity(value.db, value.session, value.file)).toThrow('identity or schema');
    writeFileSync(value.file, '{"type":"session","id":"pi-1","version":2}\n');
    expect(() => assertPiSessionContinuity(value.db, value.session, value.file)).toThrow('identity or schema');
    writeFileSync(value.file, '{"type":"not-session","id":"pi-1"}\n');
    expect(() => inspectPiSessionFile(value.file)).toThrow('missing type=session');
    value.db.close();
  });

  it('proves repeated launcher turns share one managed file and reject a concurrent writer', async () => {
    const value = setup();
    const script = join(value.directory, 'controlled-pi.mjs');
    writeFileSync(script, `
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const sessionFile = args[args.indexOf('--session') + 1];
if (args[args.indexOf('--thinking') + 1] !== 'medium' || !args.includes('--skill')) process.exit(2);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  writeFileSync(sessionFile, JSON.stringify({ type: 'session', id: 'pi-real-fixture', version: 1 }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'session', id: 'pi-real-fixture', version: 1 }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'agent_end' }) + '\\n');
  setTimeout(() => process.exit(0), 100);
});
`);
    const launcher = new PiLauncher({
      dataDir: value.directory,
      database: value.db,
      command: process.execPath,
      commandArgs: [script],
      timeoutMs: 2_000,
      cleanupTimeoutMs: 100,
    });
    const request = {
      sessionId: value.session,
      workDir: value.directory,
      prompt: '多行\\nUnicode ✓',
      systemPrompt: 'fixture system',
      model: { provider: 'openai', model: 'fixture-model', api_key: 'fixture-key' },
      skillDirs: [value.directory] as string[],
      thinkingLevel: 'medium' as const,
    };

    const first = await launcher.start(request);
    await first.wait();
    const sessionFile = join(value.directory, 'pi-sessions', `${value.session}.jsonl`);
    recordPiSessionState(value.db, value.session, sessionFile, { id: 'pi-real-fixture', schemaVersion: '1' });

    const second = await launcher.start(request);
    await second.wait();
    expect(getPiSessionState(value.db, value.session)).toMatchObject({ piSessionId: 'pi-real-fixture', status: 'active' });

    const held = await launcher.start(request);
    await expect(launcher.start(request)).rejects.toMatchObject({ code: 'pi_session_busy' });
    await held.wait();
    value.db.close();
  });
});
