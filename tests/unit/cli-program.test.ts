import { describe, expect, it, vi } from 'vitest';
import { createCliProgram, type StartServerOptions } from '@/cli/program.js';

// The session and environment command functions are replaced so the flag -> argument
// mappings can be asserted without a server. Their real behavior is covered against the
// real routes in `tests/integration/session-cli-commands.test.ts` and
// `tests/integration/environments-cli-commands.test.ts`.
const recorded = vi.hoisted(() => ({ calls: [] as unknown[][] }));

vi.mock('@/cli/session-commands.js', () => ({
  sessionCreateCommand: vi.fn((...args: unknown[]) => {
    recorded.calls.push(['create', ...args]);
  }),
  sessionMessageCommand: vi.fn((...args: unknown[]) => {
    recorded.calls.push(['message', ...args]);
  }),
  sessionTailCommand: vi.fn((...args: unknown[]) => {
    recorded.calls.push(['tail', ...args]);
  }),
  sessionInspectCommand: vi.fn((...args: unknown[]) => {
    recorded.calls.push(['inspect', ...args]);
  }),
  sessionLogsCommand: vi.fn((...args: unknown[]) => {
    recorded.calls.push(['logs', ...args]);
  }),
}));

vi.mock('@/cli/runtime-management-commands.js', () => ({
  environmentsListCommand: vi.fn((...args: unknown[]) => {
    recorded.calls.push(['env-list', ...args]);
  }),
  environmentInspectCommand: vi.fn((...args: unknown[]) => {
    recorded.calls.push(['env-inspect', ...args]);
  }),
  environmentCreateCommand: vi.fn((...args: unknown[]) => {
    recorded.calls.push(['env-create', ...args]);
  }),
  environmentUpdateCommand: vi.fn((...args: unknown[]) => {
    recorded.calls.push(['env-update', ...args]);
  }),
  environmentArchiveCommand: vi.fn((...args: unknown[]) => {
    recorded.calls.push(['env-archive', ...args]);
  }),
  environmentWorkerKeysCommand: vi.fn((...args: unknown[]) => {
    recorded.calls.push(['env-worker-keys', ...args]);
  }),
}));

vi.mock('@/cli/workspace-commands.js', () => ({
  workspaceListCommand: vi.fn((...args: unknown[]) => {
    recorded.calls.push(['ws-list', ...args]);
  }),
  workspaceCreateCommand: vi.fn((...args: unknown[]) => {
    recorded.calls.push(['ws-create', ...args]);
  }),
  workspaceOpenCommand: vi.fn((...args: unknown[]) => {
    recorded.calls.push(['ws-open', ...args]);
  }),
  workspaceResolveCommand: vi.fn((...args: unknown[]) => {
    recorded.calls.push(['ws-resolve', ...args]);
  }),
  workspaceRemoveCommand: vi.fn((...args: unknown[]) => {
    recorded.calls.push(['ws-remove', ...args]);
  }),
}));

describe('CLI program', () => {
  it('registers the public command surface', () => {
    const program = createCliProgram({
      version: '0.1.0',
      startServer: async () => undefined,
    });

    expect(program.name()).toBe('managed-agents');
    expect(program.commands.map((command) => command.name())).toEqual([
      'start',
      'init',
      'list',
      'reload',
      'chat',
      'deploy',
      'environments',
      'session',
      'workspace',
      'worker',
      'template',
    ]);
    expect(program.commands.find((command) => command.name() === 'template')?.commands.map((command) => command.name())).toEqual([
      'list',
      'install',
      'create',
    ]);
    // The environments group is documented as covered in `docs/api-matrix.md:87` — "List,
    // inspect, create, update, archive, and list worker keys" — and implemented in
    // `src/cli/runtime-management-commands.ts`; the module was imported by nothing, so
    // each answered `unknown command`. Only the environments half of that module is
    // registered: its `settings` half is broken against the real API (#466).
    expect(program.commands.find((command) => command.name() === 'environments')?.commands.map((command) => command.name())).toEqual([
      'list',
      'inspect',
      'create',
      'update',
      'archive',
      'worker-keys',
    ]);
    // The session group is documented as covered in `docs/api-matrix.md:84` — "Create,
    // message, tail, inspect, and logs" — and `src/cli/session-commands.ts` implements all
    // five; the module was imported by nothing, so each answered `unknown command`.
    expect(program.commands.find((command) => command.name() === 'session')?.commands.map((command) => command.name())).toEqual([
      'create',
      'message',
      'tail',
      'inspect',
      'logs',
    ]);
    // The workspace registry group is documented as covered in `docs/api-matrix.md:88` —
    // "Create, open/register, list, resolve, and remove local workspace registry entries" —
    // and ticked in `docs/spec/tasks.md:192`, but `src/cli/workspace-commands.ts` was
    // imported by nothing, so all five answered `unknown command`.
    expect(program.commands.find((command) => command.name() === 'workspace')?.commands.map((command) => command.name())).toEqual([
      'create',
      'open',
      'list',
      'resolve',
      'remove',
    ]);
    // The self-hosted worker CLI is documented in `docs/deployment.md:234` and the
    // Console's environment setup step; it was never registered, so the documented
    // invocation answered `unknown command 'worker'`.
    expect(program.commands.find((command) => command.name() === 'worker')?.commands.map((command) => command.name())).toEqual([
      'poll',
    ]);
  });

  it('maps the documented session flags onto the command arguments', async () => {
    // The flag -> argument mapping is pinned here with the command functions replaced, and
    // the argument -> wire behavior is pinned against the real routes in
    // `tests/integration/session-cli-commands.test.ts`. Together they cover the chain;
    // neither alone would have caught `worker poll` (#459), which was registered correctly
    // and still sent the wrong body.
    recorded.calls.length = 0;
    const run = async (...argv: string[]) => {
      const program = createCliProgram({
        version: '0.1.0',
        startServer: async () => undefined,
      });
      await program.parseAsync(['node', 'managed-agents', 'session', ...argv], { from: 'node' });
      return recorded.calls.at(-1);
    };

    expect(await run('create', '-a', 'agent_x', '-e', 'local', '-t', 'Title', '-p', '4000')).toMatchObject([
      'create',
      { port: '4000', agent: 'agent_x', environment: 'local', title: 'Title' },
    ]);
    // `stream` defaults to true, so the command streams unless `--no-stream` is passed.
    // This exact pair is what `sessionMessageCommand`'s `opts.stream === false` branch
    // depends on, and it cannot be read off `.opts()` before parsing: commander applies
    // the `--no-x` default during the parse, so a pre-parse `opts()` omits `stream`
    // entirely and would make the mapping look unverified when it is simply unbuilt.
    expect(await run('message', 'sess_1', '-m', 'hi')).toEqual([
      'message',
      'sess_1',
      { port: '3000', stream: true, message: 'hi' },
    ]);
    expect(await run('message', 'sess_1', '-m', 'hi', '--no-stream')).toEqual([
      'message',
      'sess_1',
      { port: '3000', stream: false, message: 'hi' },
    ]);
    expect(await run('tail', 'sess_1', '--last-event-id', '7')).toMatchObject([
      'tail',
      'sess_1',
      { port: '3000', lastEventId: '7' },
    ]);
    expect(await run('inspect', 'sess_1', '--json')).toMatchObject([
      'inspect',
      'sess_1',
      { port: '3000', json: true },
    ]);
    expect(await run('inspect', 'sess_1')).toMatchObject(['inspect', 'sess_1', { port: '3000', json: false }]);
    expect(await run('logs', 'sess_1')).toMatchObject(['logs', 'sess_1', { port: '3000' }]);
  });

  it('maps the documented environments flags onto the command arguments', async () => {
    // Same split as the session group: this pins flag -> argument, and
    // `tests/integration/environments-cli-commands.test.ts` pins argument -> wire. The
    // camelCase spellings matter because the command functions read `hostingType`,
    // `sandboxProvider` and `configJson`, and a hyphenated key would arrive as `undefined`
    // — a silent omission the server would accept by leaving the field unset.
    recorded.calls.length = 0;
    const run = async (...argv: string[]) => {
      const program = createCliProgram({
        version: '0.1.0',
        startServer: async () => undefined,
      });
      await program.parseAsync(['node', 'managed-agents', 'environments', ...argv], { from: 'node' });
      return recorded.calls.at(-1);
    };

    expect(await run('list', '--json', '-p', '4000')).toMatchObject([
      'env-list',
      { port: '4000', json: true },
    ]);
    expect(await run('inspect', 'env_1')).toMatchObject(['env-inspect', 'env_1', { port: '3000' }]);
    expect(await run(
      'create',
      '--name', 'staging',
      '--description', 'Build box',
      '--hosting-type', 'local',
      '--sandbox-provider', 'local',
      '--config-json', '{"a":1}',
    )).toMatchObject([
      'env-create',
      {
        port: '3000',
        name: 'staging',
        description: 'Build box',
        hostingType: 'local',
        sandboxProvider: 'local',
        configJson: '{"a":1}',
      },
    ]);
    // `create` requires a name; `update` does not, because it patches an existing row.
    expect(await run('update', 'env_1', '--name', 'renamed')).toMatchObject([
      'env-update',
      'env_1',
      { port: '3000', name: 'renamed' },
    ]);
    expect(await run('archive', 'env_1')).toMatchObject(['env-archive', 'env_1', { port: '3000' }]);
    expect(await run('worker-keys', 'env_1')).toMatchObject([
      'env-worker-keys',
      'env_1',
      { port: '3000' },
    ]);
  });

  it('maps the documented workspace flags onto the command arguments', async () => {
    // `workspace` is the one group that is not an HTTP client: it reads and writes a local
    // registry file. The mapping is pinned here and the on-disk behavior in
    // `tests/integration/workspace-cli-commands.test.ts`.
    recorded.calls.length = 0;
    const run = async (...argv: string[]) => {
      const program = createCliProgram({
        version: '0.1.0',
        startServer: async () => undefined,
      });
      await program.parseAsync(['node', 'managed-agents', 'workspace', ...argv], { from: 'node' });
      return recorded.calls.at(-1);
    };

    expect(await run('list', '--json')).toMatchObject(['ws-list', { json: true }]);
    // `--data-dir` must land as `dataDir`: a hyphenated key would arrive `undefined` and the
    // runtime data directory would silently fall back to the default.
    expect(await run('create', 'C:\\box', '--name', 'Box', '--data-dir', 'C:\\data')).toMatchObject([
      'ws-create',
      'C:\\box',
      { name: 'Box', dataDir: 'C:\\data' },
    ]);
    expect(await run('open', 'C:\\box')).toMatchObject(['ws-open', 'C:\\box', { json: false }]);
    expect(await run('resolve', 'box-1234abcd', '--json')).toMatchObject([
      'ws-resolve',
      'box-1234abcd',
      { json: true },
    ]);
    // `remove` is the only one with no options at all, so it is passed no options object.
    expect(await run('remove', 'C:\\box')).toEqual(['ws-remove', 'C:\\box']);
  });

  it('exposes the documented session options', () => {
    const program = createCliProgram({
      version: '0.1.0',
      startServer: async () => undefined,
    });

    const session = program.commands.find((command) => command.name() === 'session');
    const sub = (name: string) => session?.commands.find((command) => command.name() === name);
    const longs = (name: string) => sub(name)!.options.map((option) => option.long).sort();

    // `--agent` names an id, not a name: the route requires an `agent_...` id
    // (`src/api/routes/sessions.ts:84`) and every published example passes `$AGENT_ID`.
    expect(longs('create')).toEqual(['--agent', '--api-key', '--environment', '--port', '--title']);
    expect(longs('message')).toEqual(['--api-key', '--message', '--no-stream', '--port']);
    expect(longs('tail')).toEqual(['--api-key', '--last-event-id', '--port']);
    expect(longs('inspect')).toEqual(['--api-key', '--json', '--port']);
    expect(longs('logs')).toEqual(['--api-key', '--port']);
    // Required rather than optional: the command cannot be run without a message.
    expect(sub('message')!.options.find((option) => option.long === '--message')!.mandatory).toBe(true);
  });

  it('exposes the documented worker poll options', () => {
    const program = createCliProgram({
      version: '0.1.0',
      startServer: async () => undefined,
    });

    const poll = program.commands
      .find((command) => command.name() === 'worker')
      ?.commands.find((command) => command.name() === 'poll');

    expect(poll).toBeDefined();
    expect(poll!.options.map((option) => option.long).sort()).toEqual([
      '--api-key',
      '--environment-id',
      '--environment-key',
      '--interval-ms',
      '--once',
      '--port',
      '--workdir',
      '--worker-id',
    ]);
    // The options the documented invocation relies on, with their documented defaults,
    // asserted by value rather than by the list above, which would pass on any
    // option that happened to have the right name.
    expect(poll!.opts()).toMatchObject({ port: '3000', workdir: '.', intervalMs: '1000', once: false });
  });

  it('passes default start options to the runtime starter', async () => {
    let received: StartServerOptions | undefined;
    const program = createCliProgram({
      version: '0.1.0',
      startServer: async (opts) => {
        received = opts;
      },
    });

    await program.parseAsync(['node', 'managed-agents', 'start'], { from: 'node' });

    expect(received).toMatchObject({
      port: '3000',
      host: '127.0.0.1',
      workspace: '.',
      agentsDir: 'agents',
      skillsDir: 'skills',
      target: 'local',
    });
  });
});
