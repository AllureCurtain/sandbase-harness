import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  workspaceCreateCommand,
  workspaceListCommand,
  workspaceOpenCommand,
  workspaceRemoveCommand,
  workspaceResolveCommand,
} from '@/cli/workspace-commands.js';
import { registerWorkspace, type WorkspaceRegistryEntry } from '@/core/workspace/registry.js';
import { defaultConfigPath, WORKSPACE_STATE_DIR } from '@/core/config/paths.js';

// These commands do not talk to a runtime at all: they read and write a local registry
// file, so there is no HTTP listener here and no `--port`. The registry location is
// `$MANAGED_AGENTS_HOME/workspaces.json` (`src/core/config/paths.ts:8`), which is what makes
// these testable without writing to the developer's real home directory — the commands
// themselves never pass a `home`, they rely on that variable.
let home: string;
let root: string;
let originalHome: string | undefined;
let originalExitCode: typeof process.exitCode;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ws-home-'));
  root = mkdtempSync(join(tmpdir(), 'ws-root-'));
  originalHome = process.env.MANAGED_AGENTS_HOME;
  process.env.MANAGED_AGENTS_HOME = home;
  // `workspaceResolveCommand` and `workspaceRemoveCommand` set `process.exitCode` on a
  // miss. That is process-global, so it is captured and restored rather than left set:
  // a leaked non-zero exit code would fail this test run from outside the assertions.
  originalExitCode = process.exitCode;
  process.exitCode = undefined;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.MANAGED_AGENTS_HOME;
  else process.env.MANAGED_AGENTS_HOME = originalHome;
  process.exitCode = originalExitCode;
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

/** Read the registry file directly, rather than through the module that wrote it. */
function readRegistryEntries(): WorkspaceRegistryEntry[] {
  const path = join(home, 'workspaces.json');
  if (!existsSync(path)) return [];
  return (JSON.parse(readFileSync(path, 'utf8')) as { workspaces: WorkspaceRegistryEntry[] }).workspaces;
}

async function capture(fn: () => void) {
  const log: string[] = [];
  const errors: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    log.push(args.map(String).join(' '));
  });
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });
  try {
    await fn();
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  }
  return { log, errors };
}

describe('workspace CLI commands', () => {
  it('create builds the workspace on disk and registers it', async () => {
    const { log } = await capture(() => workspaceCreateCommand(root, { name: 'Build box' }));

    expect(log.join('\n')).toContain('Created workspace:');
    expect(log.join('\n')).toContain('Build box');

    // The directory layout is part of the command's contract, so it is asserted on disk
    // rather than inferred from the printed line: `create` is documented as creating a
    // workspace, and an entry alone would be a registry row pointing at nothing.
    expect(existsSync(join(root, 'agents'))).toBe(true);
    expect(existsSync(join(root, 'skills'))).toBe(true);
    expect(existsSync(defaultConfigPath(root))).toBe(true);
    expect(readFileSync(defaultConfigPath(root), 'utf8')).toContain('sandbox_provider: local');

    const entries = readRegistryEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe('Build box');
    expect(entries[0]!.root).toBe(root);
    expect(entries[0]!.data_dir).toBe(join(root, '.managed-agents'));
    // The id is derived from the root, so it is stable and predictable rather than random.
    expect(entries[0]!.id).toMatch(/^[a-z0-9._-]+-[0-9a-f]{8}$/);
  });

  it('create with --json prints the entry the registry stored', async () => {
    const { log } = await capture(() => workspaceCreateCommand(root, { json: true }));

    const printed = JSON.parse(log.join('\n')) as WorkspaceRegistryEntry;
    const stored = readRegistryEntries()[0]!;
    expect(printed).toEqual(stored);
    // Without --name the display name falls back to the directory basename, and the id is
    // derived from it.
    expect(printed.name).toBe(root.split(/[\\/]/).pop());
  });

  it('open registers an existing root and creates nothing in it', async () => {
    const marker = join(root, 'already-here.txt');
    writeFileSync(marker, 'kept', 'utf8');

    const { log } = await capture(() => workspaceOpenCommand(root, { name: 'Existing' }));

    expect(log.join('\n')).toContain('Registered workspace:');
    expect(readRegistryEntries()[0]!.name).toBe('Existing');
    // The whole difference between `create` and `open`: opening must not scaffold. Asserting
    // the marker alone would pass even if the command had written both directories, so the
    // two scaffold paths are asserted absent by name.
    expect(existsSync(join(root, 'agents'))).toBe(false);
    expect(existsSync(join(root, 'skills'))).toBe(false);
    expect(existsSync(defaultConfigPath(root))).toBe(false);
    expect(readFileSync(marker, 'utf8')).toBe('kept');
  });

  it('re-registering the same root updates one entry and keeps its created_at', async () => {
    await capture(() => workspaceCreateCommand(root, { name: 'First' }));
    const createdAt = readRegistryEntries()[0]!.created_at;

    await capture(() => workspaceOpenCommand(root, { name: 'Renamed' }));

    const entries = readRegistryEntries();
    // Not a second row: the registry is keyed by resolved root, and a duplicate would make
    // `resolve` ambiguous and `remove` able to leave a twin behind.
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe('Renamed');
    expect(entries[0]!.created_at).toBe(createdAt);
    expect(entries[0]!.last_opened_at >= createdAt).toBe(true);
  });

  it('list says so plainly when the registry is empty', async () => {
    const { log } = await capture(() => workspaceListCommand({}));

    expect(log.join('\n')).toBe('No workspaces registered.');
  });

  it('list prints the most recently opened workspace first', async () => {
    // Seeded through the registry module with explicit times rather than through the
    // commands: `registerWorkspace` stamps `new Date()`, which has millisecond resolution,
    // so two CLI registrations in a row can share a timestamp and leave the order genuinely
    // undefined. Fixed past times make this assertion about the sort and nothing else.
    const older = registerWorkspace({ root: join(root, 'older'), name: 'Older', home, now: new Date('2020-01-01T00:00:00.000Z') });
    const newer = registerWorkspace({ root: join(root, 'newer'), name: 'Newer', home, now: new Date('2021-01-01T00:00:00.000Z') });
    expect(readRegistryEntries().map((entry) => entry.id)).toEqual([newer.id, older.id]);

    const { log } = await capture(() => workspaceListCommand({}));

    const lines = log.join('\n').split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(newer.id);
    expect(lines[1]).toContain(older.id);
    // The printed form carries the root and data directory, which is what makes the line
    // usable without a second lookup.
    expect(lines[0]).toContain(join(root, 'newer'));
    expect(lines[0]).toContain(`data=${join(root, 'newer', '.managed-agents')}`);
  });

  it('list --json prints every registry entry', async () => {
    await capture(() => workspaceCreateCommand(root, { name: 'One' }));

    const { log } = await capture(() => workspaceListCommand({ json: true }));

    expect(JSON.parse(log.join('\n'))).toEqual(readRegistryEntries());
  });

  it('resolve prints one workspace and marks it as just opened', async () => {
    const older = registerWorkspace({ root: join(root, 'older'), name: 'Older', home, now: new Date('2020-01-01T00:00:00.000Z') });
    const newer = registerWorkspace({ root: join(root, 'newer'), name: 'Newer', home, now: new Date('2021-01-01T00:00:00.000Z') });

    const { log } = await capture(() => workspaceResolveCommand(newer.id, {}));
    expect(log.join('\n')).toContain(newer.id);
    expect(log.join('\n')).not.toContain(older.id);

    // `resolve` is not a read: it bumps `last_opened_at`, which reorders the listing. Worth
    // pinning because a caller who resolves inside a loop silently rewrites the registry.
    expect(readRegistryEntries().find((entry) => entry.id === newer.id)!.last_opened_at > newer.last_opened_at).toBe(true);
    const { log: afterList } = await capture(() => workspaceListCommand({}));
    expect(afterList.join('\n').split('\n')[0]).toContain(newer.id);
  });

  it('resolve accepts an id, a name, or a root', async () => {
    await capture(() => workspaceCreateCommand(root, { name: 'By name' }));
    const stored = readRegistryEntries()[0]!;

    for (const identifier of [stored.id, stored.name, stored.root]) {
      const { log, errors } = await capture(() => workspaceResolveCommand(identifier, { json: true }));
      expect(errors, `identifier: ${identifier}`).toEqual([]);
      expect(JSON.parse(log.join('\n')).id, `identifier: ${identifier}`).toBe(stored.id);
    }
  });

  it('resolve refuses an unknown workspace and sets a failing exit code', async () => {
    const { log, errors } = await capture(() => workspaceResolveCommand('nope', {}));

    expect(log).toEqual([]);
    expect(errors.join('\n')).toContain('Workspace not found: nope');
    expect(process.exitCode).toBe(1);
  });

  it('remove drops only the named workspace, leaves its files alone, and resolve then fails', async () => {
    const keeper = join(root, 'keeper');
    await capture(() => workspaceCreateCommand(root, { name: 'Doomed' }));
    await capture(() => workspaceCreateCommand(keeper, { name: 'Keeper' }));
    const configPath = defaultConfigPath(root);
    const keeperEntry = readRegistryEntries().find((entry) => entry.root === keeper)!;
    expect(readRegistryEntries()).toHaveLength(2);

    const { log } = await capture(() => workspaceRemoveCommand(root));

    expect(log.join('\n')).toContain(`Removed workspace: ${root}`);
    // The sibling has to survive. A removal that emptied the registry, or that filtered on
    // anything but the match, passes a single-entry test while destroying unrelated
    // registrations — which is the destructive case worth a probe of its own.
    expect(readRegistryEntries().map((entry) => entry.id)).toEqual([keeperEntry.id]);
    // Removing is documented as a registry removal, not a delete. If this ever became a
    // recursive delete it would destroy a user's agents and sessions without a prompt, so
    // the surviving files are asserted rather than assumed.
    expect(existsSync(configPath)).toBe(true);
    expect(existsSync(join(root, 'agents'))).toBe(true);

    const { log: afterList } = await capture(() => workspaceListCommand({}));
    expect(afterList.join('\n')).toContain('Keeper');
    expect(afterList.join('\n')).not.toContain('Doomed');

    // Gone, not merely hidden from the listing: the Issue asks for the failure to be
    // asserted rather than inferred from an absence.
    const { log: resolveLog, errors } = await capture(() => workspaceResolveCommand(root, {}));
    expect(resolveLog).toEqual([]);
    expect(errors.join('\n')).toContain(`Workspace not found: ${root}`);
    expect(process.exitCode).toBe(1);
  });

  it('remove refuses an unknown workspace and sets a failing exit code', async () => {
    const { log, errors } = await capture(() => workspaceRemoveCommand('nope'));

    expect(log).toEqual([]);
    expect(errors.join('\n')).toContain('Workspace not found: nope');
    expect(process.exitCode).toBe(1);
  });

  it('--json parses for every command that declares it', async () => {
    const createLog = (await capture(() => workspaceCreateCommand(root, { name: 'Json', json: true }))).log;
    const openLog = (await capture(() => workspaceOpenCommand(root, { name: 'Json again', json: true }))).log;
    const stored = readRegistryEntries()[0]!;
    const resolveLog = (await capture(() => workspaceResolveCommand(stored.id, { json: true }))).log;
    const listLog = (await capture(() => workspaceListCommand({ json: true }))).log;

    for (const [command, log] of [['create', createLog], ['open', openLog], ['resolve', resolveLog]] as const) {
      const parsed = JSON.parse(log.join('\n')) as WorkspaceRegistryEntry;
      expect(parsed.id, command).toBe(stored.id);
      expect(parsed.root, command).toBe(root);
    }
    // `list` is the registry itself, read back after `resolve` bumped `last_opened_at`.
    expect(JSON.parse(listLog.join('\n'))).toEqual(readRegistryEntries());
  });

  it('never writes to the default runtime home', async () => {
    // Every command is redirected by `MANAGED_AGENTS_HOME`, which the test sets to a temp
    // directory. A command that forgot to honour it would read and write the developer's
    // real `~/.managed-agents/workspaces.json` — and `remove` would delete a registration
    // there — so the real file is compared before and after rather than assumed untouched.
    const realRegistry = join(homedir(), WORKSPACE_STATE_DIR, 'workspaces.json');
    const before = existsSync(realRegistry) ? readFileSync(realRegistry, 'utf8') : null;

    await capture(() => workspaceCreateCommand(root, { name: 'Isolated' }));
    await capture(() => workspaceListCommand({}));
    await capture(() => workspaceResolveCommand(root, {}));
    await capture(() => workspaceRemoveCommand(root));
    await capture(() => workspaceOpenCommand(root, {}));

    expect(existsSync(realRegistry) ? readFileSync(realRegistry, 'utf8') : null).toBe(before);
    expect(existsSync(join(home, 'workspaces.json'))).toBe(true);
  });
});
