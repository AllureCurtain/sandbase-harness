/**
 * Minimal SSE MCP server whose only tool reports the Authorization header it saw.
 *
 * Exported as a starter rather than as a script so a test can host it in-process:
 * a credential-transport case needs a server that can only be reached over the
 * network, and this one can say which header arrived, which is the half of the
 * published credential contract a stdio server cannot show. It reports the header
 * from the message POST, falling back to the one on the SSE request, so a
 * credential that rides only one leg is visible as such.
 */
import { createServer } from 'node:http';

export async function startSseCredentialMcpServer() {
  const streams = new Set();
  let sseAuthorization;

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/sse') {
      sseAuthorization = req.headers.authorization;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      // Tells the client where to POST its messages.
      res.write('event: endpoint\ndata: /messages\n\n');
      streams.add(res);
      req.on('close', () => streams.delete(res));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/messages') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        let message;
        try {
          message = JSON.parse(body);
        } catch {
          res.writeHead(400).end();
          return;
        }
        res.writeHead(202).end();
        // A notification has no id and expects no response.
        if (message.id === undefined) return;
        const result = respond(message.method, req.headers.authorization ?? sseAuthorization);
        const payload = JSON.stringify({ jsonrpc: '2.0', id: message.id, result });
        for (const stream of streams) stream.write(`event: message\ndata: ${payload}\n\n`);
      });
      return;
    }

    res.writeHead(404).end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}/sse`,
    async close() {
      for (const stream of streams) stream.end();
      streams.clear();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function respond(method, authorization) {
  if (method === 'initialize') {
    return {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'sse-credential-mcp', version: '1.0.0' },
    };
  }
  if (method === 'tools/list') {
    return {
      tools: [{
        name: 'report_auth',
        description: 'Report the Authorization header this request carried',
        inputSchema: { type: 'object', properties: {} },
      }],
    };
  }
  if (method === 'tools/call') {
    return { content: [{ type: 'text', text: `AUTHORIZATION=${authorization ?? 'none'}` }] };
  }
  return {};
}
