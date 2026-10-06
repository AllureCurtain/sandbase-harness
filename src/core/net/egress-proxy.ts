/**
 * Session egress proxy — the network boundary a `limited` environment policy
 * is enforced through.
 *
 * One instance is bound per session sandbox that needs a boundary:
 *
 * - The local provider binds it to loopback and hands subprocesses proxy
 *   environment variables. Enforcement there is advisory: a process that
 *   ignores proxy variables egresses freely, which is why the provider reports
 *   `networkPolicyEnforcement: 'best_effort'`.
 * - The docker provider binds it to every host interface and puts the session
 *   container on an `--internal` network whose only reachable peer is a tiny
 *   TCP-relay sidecar that forwards to this proxy. The container's only egress
 *   is the proxy, so the allowlist is enforced.
 *
 * The proxy speaks both halves of the HTTP proxy contract: `CONNECT` for HTTPS
 * tunnels and absolute-URI forwarding for plain HTTP. Every request carries a
 * per-proxy `Proxy-Authorization` credential — generated at construction —
 * because the listener a docker relay forwards to is not loopback-only, and a
 * listener a local subprocess reaches is reachable by any host process. The
 * credential rides inside the proxy URL handed to subprocesses; it gates the
 * proxy, it is not a vault secret.
 *
 * Admission is host-level: a target must match one of the policy's
 * `hostMatchesPattern` patterns (`host`, `*.suffix`, optional `:port`). DNS
 * happens here, in the runtime process, never inside the sandbox — an
 * `--internal` docker network deliberately resolves no external names, and
 * proxy-form requests carry the target *name*, so the client never resolves
 * and DNS rebinding inside the sandbox has nothing to rebind to.
 */

import { randomBytes } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { hostMatchesPattern } from '@/core/credentials/policy.js';

/** Proxy-protocol username; the per-instance credential is the password. */
const PROXY_USERNAME = 'sandbase';
/** Ports a CONNECT may tunnel. The policy is host-level; the port floor keeps a proxy from becoming a raw-TCP relay. */
const CONNECT_PORTS = new Set([80, 443, 8080, 8443]);

export interface EgressProxyOptions {
  /** Host patterns a target must match (`host`, `*.suffix`, `host:port`). */
  allowedHosts: readonly string[];
  /** Credential required on every request. Generated when omitted. */
  token?: string;
}

export class EgressProxy {
  private readonly server: http.Server;
  private readonly sockets = new Set<net.Socket>();
  private readonly token: string;
  private readonly allowedHosts: readonly string[];
  private boundHost = '';
  private boundPort = 0;

  private constructor(options: EgressProxyOptions) {
    this.token = options.token ?? randomBytes(18).toString('base64url');
    this.allowedHosts = [...options.allowedHosts];
    this.server = http.createServer((req, res) => this.handleForward(req, res));
    // The connect event's socket is typed as stream.Duplex; for a plain TCP
    // server it is always a net.Socket.
    this.server.on('connect', (req, socket, head) => this.handleConnect(req, socket as net.Socket, head));
    // Track sockets so close() can drain a tunnel a session left open.
    // CONNECT sockets are handled by the same event: once upgraded they are no
    // longer server-managed, but they were added at 'connection'.
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
  }

  /** Bind the proxy on `host` with an ephemeral port. */
  static async listen(host: string, options: EgressProxyOptions): Promise<EgressProxy> {
    const proxy = new EgressProxy(options);
    await new Promise<void>((resolve, reject) => {
      proxy.server.once('error', reject);
      proxy.server.listen(0, host, resolve);
    });
    const address = proxy.server.address();
    if (!address || typeof address === 'string') {
      proxy.server.close();
      throw new Error('egress proxy failed to bind');
    }
    proxy.boundHost = host;
    proxy.boundPort = address.port;
    return proxy;
  }

  get host(): string {
    return this.boundHost;
  }

  get port(): number {
    return this.boundPort;
  }

  /**
   * The proxy URL, credentials embedded (`http://user:token@host:port`) — the
   * spelling `HTTP_PROXY` clients accept. `forHost`/`forPort` override the
   * advertised address, for callers that reach the listener through a relay
   * rather than its bind address.
   */
  proxyUrl(forHost?: string, forPort?: number): string {
    return `http://${PROXY_USERNAME}:${this.token}@${forHost ?? this.boundHost}:${forPort ?? this.boundPort}`;
  }

  /**
   * The environment block that routes a subprocess's HTTP(S) traffic through
   * this proxy. Uppercase and lowercase spellings are both set: runtimes split
   * on which they read (`curl` reads lowercase, many libraries read
   * uppercase). `NO_PROXY` keeps loopback direct — a `limited` policy bounds
   * egress to remote hosts, and a local service is not egress.
   */
  environment(forHost?: string, forPort?: number): Record<string, string> {
    const url = this.proxyUrl(forHost, forPort);
    return {
      HTTP_PROXY: url,
      http_proxy: url,
      HTTPS_PROXY: url,
      https_proxy: url,
      ALL_PROXY: url,
      all_proxy: url,
      NO_PROXY: 'localhost,127.0.0.1,::1',
      no_proxy: 'localhost,127.0.0.1,::1',
    };
  }

  /** The credential as a `Proxy-Authorization` value; exposed for tests and relays. */
  authorizationHeader(): string {
    return `Basic ${Buffer.from(`${PROXY_USERNAME}:${this.token}`).toString('base64')}`;
  }

  /** True when `host[:port]` matches the policy this proxy serves. */
  allows(target: string): boolean {
    return this.allowedHosts.some((pattern) => hostMatchesPattern(target, pattern));
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }

  // ============================================================
  // CONNECT (HTTPS tunnel)
  // ============================================================

  private handleConnect(
    req: http.IncomingMessage,
    clientSocket: net.Socket,
    head: Buffer,
  ): void {
    if (!this.authorized(req)) {
      clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="egress"\r\n\r\n');
      return;
    }
    const target = parseConnectTarget(req.url ?? '');
    if (!target || !CONNECT_PORTS.has(target.port) || !this.allows(target.authority)) {
      clientSocket.end('HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\negress denied by environment network policy\n');
      return;
    }
    const upstream = net.connect(target.port, target.host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
    clientSocket.on('close', () => upstream.destroy());
    upstream.on('close', () => clientSocket.destroy());
  }

  // ============================================================
  // Plain HTTP forwarding (absolute-URI or origin-form + Host)
  // ============================================================

  private handleForward(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!this.authorized(req)) {
      res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="egress"' });
      res.end();
      return;
    }
    const target = forwardTarget(req);
    if (!target) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('proxy requests must carry an absolute URI or a Host header\n');
      return;
    }
    if (!this.allows(target.authority)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end(`egress to ${target.authority} denied by environment network policy\n`);
      return;
    }

    const headers = { ...req.headers };
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];
    headers.host = target.hostHeader;
    const upstream = http.request(
      {
        host: target.host,
        port: target.port,
        path: target.path,
        method: req.method,
        headers,
        agent: false,
      },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('egress proxy upstream connection failed\n');
    });
    req.pipe(upstream);
  }

  private authorized(req: http.IncomingMessage): boolean {
    return req.headers['proxy-authorization'] === this.authorizationHeader();
  }
}

// ============================================================
// Request parsing
// ============================================================

interface ConnectTarget {
  host: string;
  port: number;
  /** `host` or `host:port`, the spelling allowlist patterns match against. */
  authority: string;
}

function parseConnectTarget(url: string): ConnectTarget | undefined {
  const match = /^(.+):(\d+)$/.exec(url.trim());
  if (!match) return undefined;
  const host = match[1].replace(/^\[|\]$/g, '').toLowerCase();
  const port = Number(match[2]);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  // The authority keeps the port: a pattern without one is port-agnostic, and
  // a pattern with one (`example.com:8443`) must be able to require it.
  return { host, port, authority: `${host}:${port}` };
}

interface ForwardTarget {
  host: string;
  port: number;
  authority: string;
  hostHeader: string;
  path: string;
}

/**
 * Resolve a forward request's destination. Absolute-URI form is the proxy
 * contract; origin-form plus `Host` is accepted because some clients send it
 * anyway. Only `http:` targets are forwarded — `https:` arrives as CONNECT.
 */
function forwardTarget(req: http.IncomingMessage): ForwardTarget | undefined {
  const rawUrl = req.url ?? '';
  if (rawUrl.startsWith('http://')) {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return undefined;
    }
    const host = url.hostname.toLowerCase();
    const port = url.port ? Number(url.port) : 80;
    return {
      host,
      port,
      authority: `${host}:${port}`,
      hostHeader: url.host,
      path: `${url.pathname}${url.search}`,
    };
  }
  // Origin-form (`GET /path`) is only a proxy request when a Host header names
  // the destination; anything else is not a shape this proxy answers.
  if (!rawUrl.startsWith('/')) return undefined;
  const authority = (req.headers.host ?? '').trim().toLowerCase();
  if (!authority) return undefined;
  const split = authority.match(/^(.+):(\d+)$/);
  const host = (split ? split[1] : authority).replace(/^\[|\]$/g, '');
  const port = split ? Number(split[2]) : 80;
  return {
    host,
    port,
    authority: `${host}:${port}`,
    hostHeader: authority,
    path: rawUrl,
  };
}
