/**
 * The per-session egress proxy a `limited` environment policy is enforced
 * through.
 *
 * The suite stands up a real upstream on loopback and drives the proxy as a
 * client would: absolute-URI HTTP forwarding, CONNECT tunneling, the
 * per-session Proxy-Authorization credential, and the allowlist's host[:port]
 * semantics — the same `hostMatchesPattern` rules the credential policy uses.
 */

import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { EgressProxy } from '@/core/net/egress-proxy.js';

const openResources: Array<{ close(): Promise<void> | void }> = [];

afterEach(async () => {
  while (openResources.length > 0) {
    await openResources.pop()?.close();
  }
});

function listenHttp(): Promise<http.Server & { port: number }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`upstream ${req.method} ${req.url}`);
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      const resource = Object.assign(server, { port });
      openResources.push({ close: () => new Promise<void>((r) => server.close(() => r())) });
      resolve(resource);
    });
  });
}

/**
 * CONNECT only tunnels to the egress port set {80, 443, 8080, 8443}, so the
 * test TCP server must take one of them. 8080 and 8443 are tried in order so
 * a developer machine with a dev server on 8080 still exercises the tunnel.
 */
async function listenTcpEcho(): Promise<{ server: net.Server; port: number }> {
  for (const port of [8080, 8443]) {
    const server = net.createServer((socket) => socket.pipe(socket));
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
      openResources.push({ close: () => new Promise<void>((r) => server.close(() => r())) });
      return { server, port };
    } catch {
      server.close();
    }
  }
  throw new Error('no CONNECT-test port free');
}

async function startProxy(allowedHosts: string[]): Promise<EgressProxy> {
  const proxy = await EgressProxy.listen('127.0.0.1', { allowedHosts });
  openResources.push(proxy);
  return proxy;
}

function requestThroughProxy(
  proxy: EgressProxy,
  options: http.RequestOptions & { authorize?: boolean; body?: string },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: proxy.host,
        port: proxy.port,
        agent: false,
        ...options,
        headers: {
          ...(options.authorize === false ? {} : { 'proxy-authorization': proxy.authorizationHeader() }),
          ...options.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

function connectThroughProxy(
  proxy: EgressProxy,
  target: string,
  authorize = true,
): Promise<{ socket: net.Socket; statusLine: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxy.port, proxy.host, () => {
      socket.write(
        `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n`
        + (authorize ? `Proxy-Authorization: ${proxy.authorizationHeader()}\r\n` : '')
        + '\r\n',
      );
    });
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.includes('\r\n\r\n')) {
        resolve({ socket, statusLine: buffer.split('\r\n')[0] });
      }
    });
    socket.on('error', reject);
    socket.on('close', () => {
      if (!buffer.includes('\r\n\r\n')) reject(new Error(`socket closed before response: ${buffer.slice(0, 80)}`));
    });
    openResources.push({ close: () => { socket.destroy(); } });
  });
}

describe('egress proxy — HTTP forwarding', () => {
  it('forwards an absolute-URI request to an allowed host', async () => {
    const upstream = await listenHttp();
    const proxy = await startProxy([`127.0.0.1:${upstream.port}`]);

    const res = await requestThroughProxy(proxy, {
      method: 'GET',
      path: `http://127.0.0.1:${upstream.port}/page?q=1`,
    });
    expect(res.status).toBe(200);
    expect(res.body).toBe('upstream GET /page?q=1');
  });

  it('forwards an origin-form request routed by its Host header', async () => {
    const upstream = await listenHttp();
    const proxy = await startProxy([`127.0.0.1:${upstream.port}`]);

    const res = await requestThroughProxy(proxy, {
      method: 'GET',
      path: '/page',
      headers: { host: `127.0.0.1:${upstream.port}` },
    });
    expect(res.status).toBe(200);
  });

  it('refuses a host the policy does not cover', async () => {
    const upstream = await listenHttp();
    const proxy = await startProxy([`127.0.0.1:${upstream.port + 1}`]);

    const res = await requestThroughProxy(proxy, {
      method: 'GET',
      path: `http://127.0.0.1:${upstream.port}/page`,
    });
    expect(res.status).toBe(403);
    expect(res.body).toContain('egress to');
  });

  it('refuses a request without the per-session credential', async () => {
    const upstream = await listenHttp();
    const proxy = await startProxy([`127.0.0.1:${upstream.port}`]);

    const res = await requestThroughProxy(proxy, {
      method: 'GET',
      path: `http://127.0.0.1:${upstream.port}/page`,
      authorize: false,
    });
    expect(res.status).toBe(407);
  });

  it('does not leak the credential upstream', async () => {
    const seen: string[] = [];
    const echo = http.createServer((req, res) => {
      seen.push(String(req.headers['proxy-authorization'] ?? ''));
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    await new Promise<void>((resolve, reject) => {
      echo.once('error', reject);
      echo.listen(0, '127.0.0.1', resolve);
    });
    const port = (echo.address() as AddressInfo).port;
    openResources.push({ close: () => new Promise<void>((r) => echo.close(() => r())) });
    const proxy = await startProxy([`127.0.0.1:${port}`]);

    await requestThroughProxy(proxy, {
      method: 'GET',
      path: `http://127.0.0.1:${port}/`,
    });
    expect(seen[0]).toBe('');
  });
});

describe('egress proxy — CONNECT', () => {
  it('tunnels to an allowed host:port', async () => {
    const { port } = await listenTcpEcho();
    const proxy = await startProxy([`127.0.0.1:${port}`]);

    const { socket, statusLine } = await connectThroughProxy(proxy, `127.0.0.1:${port}`);
    expect(statusLine).toBe('HTTP/1.1 200 Connection Established');

    const echoed = await new Promise<string>((resolve) => {
      socket.write('ping');
      socket.once('data', (chunk) => resolve(chunk.toString()));
    });
    expect(echoed).toBe('ping');
  });

  it('refuses a host the policy does not cover', async () => {
    const { port } = await listenTcpEcho();
    const proxy = await startProxy(['api.github.com']);

    const { statusLine } = await connectThroughProxy(proxy, `127.0.0.1:${port}`);
    expect(statusLine).toBe('HTTP/1.1 403 Forbidden');
  });

  it('refuses a CONNECT without the credential', async () => {
    const proxy = await startProxy(['127.0.0.1:443']);
    const { statusLine } = await connectThroughProxy(proxy, '127.0.0.1:443', false);
    expect(statusLine).toBe('HTTP/1.1 407 Proxy Authentication Required');
  });

  it('refuses ports outside the tunnel set', async () => {
    const proxy = await startProxy(['127.0.0.1']);
    const { statusLine } = await connectThroughProxy(proxy, '127.0.0.1:22');
    expect(statusLine).toBe('HTTP/1.1 403 Forbidden');
  });
});

describe('egress proxy — placeholder substitution', () => {
  const SECRET = 'egress-substitution-secret';

  function echoHeaders(): Promise<http.Server & { port: number; seen: Array<{ headers: http.IncomingHttpHeaders; url?: string; body: string }> }> {
    return new Promise((resolve, reject) => {
      const seen: Array<{ headers: http.IncomingHttpHeaders; url?: string; body: string }> = [];
      const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
          seen.push({ headers: req.headers, url: req.url, body: Buffer.concat(chunks).toString() });
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('ok');
        });
      });
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as AddressInfo).port;
        openResources.push({ close: () => new Promise<void>((r) => server.close(() => r())) });
        resolve(Object.assign(server, { port, seen }));
      });
    });
  }

  it('materializes a placeholder in request headers toward a scoped host', async () => {
    const upstream = await echoHeaders();
    const proxy = await startProxy([`127.0.0.1:${upstream.port}`]);
    proxy.addSubstitutions([{ placeholder: '__cred_crd_demo__', value: SECRET, allowedHosts: [`127.0.0.1:${upstream.port}`] }]);

    const res = await requestThroughProxy(proxy, {
      method: 'GET',
      path: `http://127.0.0.1:${upstream.port}/`,
      headers: { authorization: 'Bearer __cred_crd_demo__' },
    });
    expect(res.status).toBe(200);
    expect(upstream.seen[0].headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(JSON.stringify(upstream.seen[0])).not.toContain('__cred_');
  });

  it('materializes a placeholder in a request body and fixes the length', async () => {
    const upstream = await echoHeaders();
    const proxy = await startProxy([`127.0.0.1:${upstream.port}`]);
    proxy.addSubstitutions([{ placeholder: '__cred_crd_body__', value: SECRET, allowedHosts: null }]);

    const res = await requestThroughProxy(proxy, {
      method: 'POST',
      path: `http://127.0.0.1:${upstream.port}/submit`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: '__cred_crd_body__' }),
    });
    expect(res.status).toBe(200);
    expect(upstream.seen[0].body).toBe(JSON.stringify({ token: SECRET }));
    expect(upstream.seen[0].headers['content-length']).toBe(String(JSON.stringify({ token: SECRET }).length));
  });

  it('does not materialize a placeholder toward a host outside its scope', async () => {
    const upstream = await echoHeaders();
    const proxy = await startProxy([`127.0.0.1:${upstream.port}`]);
    proxy.addSubstitutions([{ placeholder: '__cred_crd_scoped__', value: SECRET, allowedHosts: ['other.example.com'] }]);

    const res = await requestThroughProxy(proxy, {
      method: 'GET',
      path: `http://127.0.0.1:${upstream.port}/`,
      headers: { authorization: 'Bearer __cred_crd_scoped__' },
    });
    expect(res.status).toBe(200);
    // The token reaches the wire untouched — the secret never does.
    expect(upstream.seen[0].headers.authorization).toBe('Bearer __cred_crd_scoped__');
    expect(JSON.stringify(upstream.seen[0])).not.toContain(SECRET);
  });

  it('updates the value a stable placeholder resolves to on re-registration', async () => {
    const upstream = await echoHeaders();
    const proxy = await startProxy([`127.0.0.1:${upstream.port}`]);
    proxy.addSubstitutions([{ placeholder: '__cred_crd_rotated__', value: 'old-value', allowedHosts: null }]);
    proxy.addSubstitutions([{ placeholder: '__cred_crd_rotated__', value: SECRET, allowedHosts: null }]);

    const res = await requestThroughProxy(proxy, {
      method: 'GET',
      path: `http://127.0.0.1:${upstream.port}/`,
      headers: { 'x-key': '__cred_crd_rotated__' },
    });
    expect(res.status).toBe(200);
    expect(upstream.seen[0].headers['x-key']).toBe(SECRET);
  });

  it('substitutes in allow-all mode, where the boundary exists for credentials', async () => {
    const upstream = await echoHeaders();
    const proxy = await EgressProxy.listen('127.0.0.1', { allowedHosts: null });
    openResources.push(proxy);
    proxy.addSubstitutions([{ placeholder: '__cred_crd_open__', value: SECRET, allowedHosts: null }]);

    const res = await requestThroughProxy(proxy, {
      method: 'GET',
      path: `http://127.0.0.1:${upstream.port}/`,
      headers: { 'x-key': '__cred_crd_open__' },
    });
    expect(res.status).toBe(200);
    expect(upstream.seen[0].headers['x-key']).toBe(SECRET);
  });
});

describe('egress proxy — environment()', () => {
  it('advertises both proxy spellings with the credential embedded', async () => {
    const proxy = await startProxy(['api.github.com']);
    const env = proxy.environment();

    for (const key of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
      expect(env[key]).toMatch(/^http:\/\/sandbase:.+@127\.0\.0\.1:\d+$/);
    }
    expect(env.NO_PROXY).toContain('localhost');
    expect(env.NO_PROXY).toContain('127.0.0.1');
  });

  it('advertises the relay address when one is supplied', async () => {
    const proxy = await startProxy(['api.github.com']);
    const env = proxy.environment('10.0.0.9', 8080);
    expect(env.HTTP_PROXY).toMatch(/^http:\/\/sandbase:.+@10\.0\.0\.9:8080$/);
  });
});
