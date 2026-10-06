#!/usr/bin/env node
/**
 * Minimal stdio MCP server whose only tool reports the proxy variables its
 * process sees.
 *
 * The egress-policy test needs a real subprocess to report what it was started
 * with: the proxy environment can only arrive through the spawn environment,
 * and nothing about it is knowable from the client side.
 */
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });
function send(message) { process.stdout.write(JSON.stringify(message) + '\n'); }
rl.on('line', (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  const { id, method } = request;
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'env-mcp', version: '1.0.0' } } });
    return;
  }
  if (method === 'notifications/initialized' || id === undefined) return;
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: [{ name: 'report_env', description: 'Return the proxy environment this process sees', inputSchema: { type: 'object', properties: {} } }] } });
    return;
  }
  if (method === 'tools/call') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        content: [{
          type: 'text',
          text: `HTTP_PROXY=${process.env.HTTP_PROXY ?? 'missing'} NO_PROXY=${process.env.NO_PROXY ?? 'missing'}`,
        }],
      },
    });
  }
});
