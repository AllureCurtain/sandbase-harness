/**
 * The identity this runtime presents to a third-party MCP server.
 *
 * `McpManager` connects outward, so its `clientInfo` is a version claim read by
 * someone else's operator — the one surface of this project's self-reporting
 * that no user of this repository sees. It carried `1.0.0`, a version this
 * project never shipped, until it was made to read the package like the CLI
 * banner and `GET /` do.
 *
 * The mock server writes the `clientInfo` it received to a file, because the
 * value only exists inside the handshake.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpManager } from '@/core/mcp/mcp-manager.js';
import type { McpServerConfig } from '@/types/agent.js';

const MOCK_SERVER = join(import.meta.dirname, '../fixtures/mock-mcp-server.mjs');
const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

describe('MCP client identity', () => {
  let manager: McpManager | undefined;
  let scratch: string | undefined;

  afterEach(async () => {
    if (manager) await manager.close();
    manager = undefined;
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
  });

  it('introduces itself with the version this package ships as', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'ma-mcp-identity-'));
    const recorded = join(scratch, 'client-info.json');
    const servers: McpServerConfig[] = [
      {
        name: 'mock',
        type: 'stdio',
        command: 'node',
        args: [MOCK_SERVER],
        env: { MOCK_MCP_CLIENT_INFO_FILE: recorded },
      },
    ];

    manager = new McpManager();
    const tools = await manager.connectAll(servers);

    // The handshake happened: a client that never connected would leave the file
    // absent and this would fail loudly rather than pass on a missing value.
    expect(tools['mcp_mock_echo']).toBeDefined();
    expect(JSON.parse(readFileSync(recorded, 'utf8'))).toEqual({
      name: 'sandbase-harness',
      version: manifest.version,
    });
  });
});
