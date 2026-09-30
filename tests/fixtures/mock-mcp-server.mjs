#!/usr/bin/env node
/**
 * Minimal MCP stdio server for tests.
 *
 * Implements just enough of the MCP JSON-RPC protocol over newline-delimited
 * stdio to satisfy the Vercel AI SDK MCP client: initialize, tools/list,
 * tools/call. Exposes a single `echo` tool.
 */

import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';

const rl = createInterface({ input: process.stdin });

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

/**
 * Record what the connecting client says it is, when a test asks for it.
 *
 * A server receiving `initialize` is the only place the caller's identity is
 * visible, so it is the only place a test can check it. Off unless the test
 * sets the variable; the path is configuration, never a value sent by a client.
 */
function recordClientInfo(params) {
  const target = process.env.MOCK_MCP_CLIENT_INFO_FILE;
  if (!target) return;
  try {
    writeFileSync(target, JSON.stringify(params?.clientInfo ?? null));
  } catch {
    // A test that cannot record will fail on its own assertion; the handshake
    // itself must not break over this.
  }
}

rl.on('line', (line) => {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }

  const { id, method } = req;

  if (method === 'initialize') {
    recordClientInfo(req.params);
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'mock-mcp', version: '1.0.0' },
      },
    });
    return;
  }

  // notifications have no id and need no response
  if (method === 'notifications/initialized' || id === undefined) {
    return;
  }

  if (method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: 'echo',
            description: 'Echo back the provided text',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
            },
          },
        ],
      },
    });
    return;
  }

  if (method === 'tools/call') {
    const text = req.params?.arguments?.text ?? '';
    send({
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: `echo: ${text}` }],
      },
    });
    return;
  }

  // Unknown method
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
});
