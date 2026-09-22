#!/usr/bin/env node
/**
 * Minimal stdio MCP server whose only tool reports the TOKEN its process sees.
 *
 * It exists so a credential-transport test can ask a real subprocess what
 * environment it was started with: the value can only arrive through the spawn
 * environment, and nothing about it is knowable from the client side.
 */
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });
function send(message) { process.stdout.write(JSON.stringify(message) + '\n'); }
rl.on('line', (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  const { id, method } = request;
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'credential-mcp', version: '1.0.0' } } });
    return;
  }
  if (method === 'notifications/initialized' || id === undefined) return;
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: [{ name: 'echo_env', description: 'Return the injected TOKEN', inputSchema: { type: 'object', properties: {} } }] } });
    return;
  }
  if (method === 'tools/call') {
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `TOKEN=${process.env.TOKEN ?? 'missing'}` }] } });
  }
});
