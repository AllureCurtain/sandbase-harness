/**
 * Version reporting: every surface that names this runtime's version names the
 * version of the package that ships it.
 *
 * The surfaces used to carry their own `0.1.0` literal while the package was
 * `0.3.8`, so the first line `start` printed and the `GET /` a client read both
 * named a runtime that does not exist. A unit test over a constant cannot catch
 * that — the constant is the thing that was wrong — so these assertions read
 * `package.json` themselves and check a *running* runtime against it.
 *
 * The runtime under test is the real entry point (`src/index.ts` through the
 * repository's `tsx` loader) on a free port in a temporary workspace, which is
 * the only way to assert the banner a user sees. The model provider is the stub
 * this suite starts, for the reason the quickstart suite starts it: the runtime
 * boots without a reachable provider, but a workspace config that names one is
 * the shape a real startup has.
 *
 * The MCP surface is checked through the official MCP SDK's in-memory transport
 * rather than by reading the server object, because `serverInfo` is what the
 * client receives on `initialize` — the claim is about the wire, not the field.
 */

import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createManagedAgentsMcpServer } from '@/mcp/server.js';
import { startRuntimeHarness } from './support/runtime-server.js';
import { startStubModelServer } from './support/stub-model-server.js';

/** Read independently of the code under test, so agreeing cannot be circular. */
const packageVersion = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;

describe('runtime version reporting', () => {
  // The budget the quickstart suite declares: the runtime is booted from source
  // through `tsx`, and a cold start with migrations is the slowest step here.
  it('prints the packaged version in the startup banner and serves it from GET /', {
    timeout: 300_000,
  }, async () => {
    const stub = await startStubModelServer();
    const runtime = await startRuntimeHarness({ modelBaseUrl: stub.baseUrl });

    try {
      const response = await fetch(`${runtime.baseUrl}/`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { name?: string; version?: string };

      expect(body.name).toBe('managed-agents');
      expect(body.version).toBe(packageVersion);

      // The banner is the first thing a new user reads; `runtime.output()` is the
      // whole of what the process printed.
      expect(runtime.output()).toContain(`managed-agents v${packageVersion}`);
      expect(runtime.output()).not.toContain('managed-agents v0.1.0');
    } finally {
      await runtime.stop();
      await stub.close();
    }
  });

  it('reports the packaged version to an MCP client on initialize', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createManagedAgentsMcpServer();
    const client = new Client({ name: 'version-reporting', version: '0.0.0' });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      expect(client.getServerVersion()).toEqual({ name: 'sandbase-harness', version: packageVersion });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
