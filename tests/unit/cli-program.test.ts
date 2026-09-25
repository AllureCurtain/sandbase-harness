import { describe, expect, it } from 'vitest';
import { createCliProgram, type StartServerOptions } from '@/cli/program.js';

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
      'worker',
      'template',
    ]);
    expect(program.commands.find((command) => command.name() === 'template')?.commands.map((command) => command.name())).toEqual([
      'list',
      'install',
      'create',
    ]);
    // The self-hosted worker CLI is documented in `docs/deployment.md:234` and the
    // Console's environment setup step; it was never registered, so the documented
    // invocation answered `unknown command 'worker'`.
    expect(program.commands.find((command) => command.name() === 'worker')?.commands.map((command) => command.name())).toEqual([
      'poll',
    ]);
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
