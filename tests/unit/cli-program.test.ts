import { describe, expect, it, vi } from 'vitest';
import { createCliProgram, type StartServerOptions } from '@/cli/program.js';

// The session command functions are replaced so the flag -> argument mapping can be
// asserted without a server. Their real behavior is covered against the real routes in
// `tests/integration/session-cli-commands.test.ts`.
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
      'session',
      'worker',
      'template',
    ]);
    expect(program.commands.find((command) => command.name() === 'template')?.commands.map((command) => command.name())).toEqual([
      'list',
      'install',
      'create',
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
