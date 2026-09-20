import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createWebFetchTool,
  domainMatchesList,
  extractHtmlText,
  hostPolicyRefusal,
} from '@/core/web/web-fetch.js';
import type { WebToolPolicy } from '@/core/agent/web-tool-policy.js';

/**
 * The suite points `webfetch.test` at a real local HTTP server through the
 * constructor-level test seam (`lookupAddresses` + `isAddressAllowed`). The
 * seam is not reachable from an agent definition or model input; the default
 * strict guard is exercised separately, without overrides.
 */

const TEST_HOST = 'webfetch.test';
const SECRET = 'sk-unit-test-secret-9e1f';

let server: Server;
let port = 0;
const requestPaths: string[] = [];

function handler(req: IncomingMessage, res: ServerResponse): void {
  const path = req.url ?? '/';
  requestPaths.push(path);
  const url = new URL(path, `http://127.0.0.1:${port}`);
  const send = (status: number, contentType: string, body: string | Buffer) => {
    res.writeHead(status, { 'content-type': contentType });
    res.end(body);
  };
  switch (url.pathname) {
    case '/page':
      send(200, 'text/html; charset=utf-8', '<html><head><title>Test Page &amp; Co</title><script>alert("evil")</script></head><body><h1>Harbor Station</h1><p>Weather: sunny &#65;</p></body></html>');
      return;
    case '/plain':
      send(200, 'text/plain', 'plain body text');
      return;
    case '/json':
      send(200, 'application/json', '{"answer":42}');
      return;
    case '/redirect-final':
      send(200, 'text/plain', 'arrived after redirect');
      return;
    case '/redirect':
      res.writeHead(302, { location: `http://${TEST_HOST}:${port}/redirect-final` });
      res.end();
      return;
    case '/redirect-evil':
      res.writeHead(302, { location: 'http://evil.test/steal' });
      res.end();
      return;
    case '/redirect-loopback':
      res.writeHead(302, { location: 'http://10.0.0.8/page' });
      res.end();
      return;
    case '/redirect-mapped':
      res.writeHead(302, { location: 'http://[::ffff:7f00:1]/page' });
      res.end();
      return;
    case '/image':
      send(200, 'image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      return;
    case '/pdf':
      send(200, 'application/pdf', Buffer.from('%PDF-1.4 fake'.repeat(4)));
      return;
    case '/error':
      send(500, 'text/plain', 'internal failure text');
      return;
    case '/secret':
      send(200, 'text/plain', `token is ${SECRET} do not leak`);
      return;
    case '/long':
      send(200, 'text/plain', 'abcdefghij'.repeat(600));
      return;
    case '/huge': {
      res.writeHead(200, { 'content-type': 'text/plain' });
      const chunk = 'x'.repeat(1024);
      for (let i = 0; i < 40; i += 1) res.write(chunk);
      res.end();
      return;
    }
    case '/slow':
      // Never answers within the test timeout; the socket is released at teardown.
      return;
    default:
      send(404, 'text/plain', 'missing');
  }
}

function testTool(options: {
  policy?: WebToolPolicy;
  strictGuard?: boolean;
  addresses?: string[];
  isAddressAllowed?: (address: string) => boolean;
  redact?: (value: unknown) => unknown;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxRedirects?: number;
}) {
  return createWebFetchTool({
    policy: options.policy,
    redact: options.redact,
    overrides: {
      lookupAddresses: async () => options.addresses ?? ['127.0.0.1'],
      // The strict default is deliberately left in place when `strictGuard` is
      // true so tests can prove the private-address rejection actually fires.
      isAddressAllowed: options.isAddressAllowed
        ?? (options.strictGuard ? undefined : () => true),
      timeoutMs: options.timeoutMs,
      maxResponseBytes: options.maxResponseBytes,
      maxRedirects: options.maxRedirects,
    },
  });
}

function url(path: string): string {
  return `http://${TEST_HOST}:${port}${path}`;
}

beforeAll(async () => {
  server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server?.closeAllConnections?.();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

describe('WebFetch successful retrieval', () => {
  it('fetches an HTML page and returns extracted text with metadata', async () => {
    const tool = testTool({ policy: { mode: 'allowed', domains: [TEST_HOST] } });
    const result = await tool.execute({ url: url('/page') });

    expect(result).toContain(`URL: ${url('/page')}`);
    expect(result).toContain('Status: 200');
    expect(result).toContain('Content-Type: text/html');
    expect(result).toContain('Title: Test Page & Co');
    expect(result).toContain('Harbor Station');
    expect(result).toContain('Weather: sunny A');
    expect(result).not.toContain('<h1>');
    expect(result).not.toContain('alert');
    expect(result).not.toMatch(/^Error:/);
  });

  it('fetches plain text and JSON bodies', async () => {
    const tool = testTool({ policy: undefined });
    expect(await tool.execute({ url: url('/plain') })).toContain('plain body text');
    expect(await tool.execute({ url: url('/json') })).toContain('{"answer":42}');
  });

  it('follows an allowed redirect and reports the final response', async () => {
    const tool = testTool({ policy: { mode: 'allowed', domains: [TEST_HOST] } });
    const result = await tool.execute({ url: url('/redirect') });
    expect(result).toContain('arrived after redirect');
    expect(result).toContain(`URL: ${url('/redirect-final')}`);
  });

  it('matches subdomains against an allowlist entry', async () => {
    const tool = testTool({ policy: { mode: 'allowed', domains: [TEST_HOST] } });
    const result = await tool.execute({ url: `http://sub.${TEST_HOST}:${port}/plain` });
    expect(result).toContain('plain body text');
  });
});

describe('WebFetch domain policy', () => {
  it('refuses a host outside the allowlist without contacting it', async () => {
    requestPaths.length = 0;
    const tool = testTool({ policy: { mode: 'allowed', domains: ['other.test'] } });
    const result = await tool.execute({ url: url('/page') });
    expect(result).toContain(`Error: WebFetch host "${TEST_HOST}" is not covered by the agent's allowed_domains`);
    expect(requestPaths).toHaveLength(0);
  });

  it('refuses a blocked host and its subdomains', async () => {
    const tool = testTool({ policy: { mode: 'blocked', domains: [TEST_HOST] } });
    expect(await tool.execute({ url: url('/page') })).toContain('blocked_domains');
    expect(await tool.execute({ url: `http://sub.${TEST_HOST}:${port}/page` })).toContain('blocked_domains');
  });

  it('refuses a redirect that leaves the allowlist at the new hop', async () => {
    requestPaths.length = 0;
    const tool = testTool({ policy: { mode: 'allowed', domains: [TEST_HOST] } });
    const result = await tool.execute({ url: url('/redirect-evil') });
    expect(result).toContain('host "evil.test" is not covered');
    // Only the first hop reached the server; the evil hop was refused by the
    // policy check, not by a connection failure.
    expect(requestPaths).toEqual(['/redirect-evil']);
  });

  it('caps redirect hops', async () => {
    const tool = testTool({ policy: undefined, maxRedirects: 2 });
    // /redirect chains to /redirect-final, so build a self-loop instead.
    const loopTool = testTool({ policy: undefined, maxRedirects: 0 });
    expect(await loopTool.execute({ url: url('/redirect') })).toContain('exceeded 0 redirects');
    expect(await tool.execute({ url: url('/redirect') })).toContain('arrived after redirect');
  });
});

describe('WebFetch SSRF and internal-target guard', () => {
  it('rejects localhost and internal host names before any lookup', async () => {
    const tool = testTool({ policy: undefined });
    expect(await tool.execute({ url: `http://localhost:${port}/page` })).toContain('internal name');
    expect(await tool.execute({ url: 'http://db.internal/page' })).toContain('internal name');
    expect(await tool.execute({ url: 'http://printer.local/page' })).toContain('internal name');
  });

  it('rejects loopback and private addresses with the default strict guard', async () => {
    const strict = testTool({ policy: undefined, strictGuard: true });
    expect(await strict.execute({ url: `http://${TEST_HOST}:${port}/page` }))
      .toContain('private or non-routable address');
    expect(await strict.execute({ url: `http://127.0.0.1:${port}/page` }))
      .toContain('private or non-routable target');
    expect(await strict.execute({ url: 'http://169.254.169.254/latest/meta-data/' }))
      .toContain('private or non-routable target');
    expect(await strict.execute({ url: 'http://10.0.0.8/private' }))
      .toContain('private or non-routable target');
  });

  it('rejects a public name that resolves to a private address (rebinding shape)', async () => {
    const strict = testTool({ policy: undefined, strictGuard: true });
    // lookupAddresses is the seam standing in for a rebinding resolver that
    // answers with 127.0.0.1; the address guard must refuse the connect.
    expect(await strict.execute({ url: url('/page') })).toContain('resolves to the private');
  });

  it('rejects a redirect to a private literal even when the first hop passes', async () => {
    // Only the test server's own loopback address is connectable here, so the
    // guard must reject the 10.0.0.8 redirect target at that hop.
    const tool = testTool({ policy: undefined, isAddressAllowed: (address) => address === '127.0.0.1' });
    expect(await tool.execute({ url: url('/redirect-loopback') })).toContain('private or non-routable target');
  });

  it('rejects IP literals under an allowlist', async () => {
    const tool = testTool({ policy: { mode: 'allowed', domains: [TEST_HOST] } });
    expect(await tool.execute({ url: `http://127.0.0.1:${port}/page` })).toContain('IP address');
  });

  // Regression guard for the string-prefix SSRF bypass: `::ffff:7f00:1` and
  // `::ffff:a9fe:a9fe` are 127.0.0.1 and 169.254.169.254 written in hex.
  // They must be refused by real byte-level parsing at every stage — direct
  // literal, resolver answer, and redirect target — and none of the
  // assertions below can pass by accidentally failing to connect: the refusal
  // messages are the guard's own, emitted before any socket is opened.
  it('refuses IPv4-mapped IPv6 loopback and link-local literals', async () => {
    const strict = testTool({ policy: undefined, strictGuard: true });
    expect(await strict.execute({ url: 'http://[::ffff:7f00:1]/page' }))
      .toContain('private or non-routable target');
    expect(await strict.execute({ url: 'http://[::ffff:a9fe:a9fe]/latest/meta-data/' }))
      .toContain('private or non-routable target');
    expect(await strict.execute({ url: 'http://[::ffff:0a00:0001]/internal' }))
      .toContain('private or non-routable target');
    expect(await strict.execute({ url: 'http://[0:0:0:0:0:ffff:7f00:1]/page' }))
      .toContain('private or non-routable target');
  });

  it('refuses a resolver that answers with a mapped private address', async () => {
    const strict = testTool({
      policy: undefined,
      strictGuard: true,
      addresses: ['::ffff:7f00:1'],
    });
    expect(await strict.execute({ url: url('/page') }))
      .toContain('resolves to the private');
  });

  it('refuses an allowlisted host whose lookup answers with mapped link-local', async () => {
    const strict = testTool({
      policy: { mode: 'allowed', domains: ['metadata-similar.test'] },
      strictGuard: true,
      addresses: ['::ffff:a9fe:a9fe'],
    });
    const result = await strict.execute({ url: 'http://metadata-similar.test/latest/meta-data/' });
    expect(result).toContain('resolves to the private');
    // Nothing reached the test server through the allowlisted name.
    expect(requestPaths).not.toContain('/latest/meta-data/');
  });

  it('refuses a redirect whose target is a mapped private literal', async () => {
    requestPaths.length = 0;
    // Under an allowlist the mapped literal is refused by the domain rule (an
    // IP can never appear in allowed_domains); without a list the address
    // guard is what refuses it. Both stop the hop before a socket opens.
    const allowlisted = testTool({
      policy: { mode: 'allowed', domains: [TEST_HOST] },
      isAddressAllowed: (address) => address === '127.0.0.1',
    });
    expect(await allowlisted.execute({ url: url('/redirect-mapped') }))
      .toContain('IP address, which cannot appear in allowed_domains');
    expect(requestPaths).toEqual(['/redirect-mapped']);

    requestPaths.length = 0;
    const open = testTool({
      policy: undefined,
      isAddressAllowed: (address) => address === '127.0.0.1',
    });
    expect(await open.execute({ url: url('/redirect-mapped') }))
      .toContain('private or non-routable target');
    expect(requestPaths).toEqual(['/redirect-mapped']);
  });
});

describe('WebFetch resource limits', () => {
  it('times out a stalled response', async () => {
    const tool = testTool({ policy: undefined, timeoutMs: 150 });
    const started = Date.now();
    const result = await tool.execute({ url: url('/slow') });
    expect(result).toContain('timed out after 150ms');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('aborts a response above the byte cap', async () => {
    const tool = testTool({ policy: undefined, maxResponseBytes: 2048 });
    expect(await tool.execute({ url: url('/huge') })).toContain('exceeds the 2048-byte limit');
  });

  it('caps extracted text by max_content_tokens', async () => {
    const tool = testTool({ policy: { mode: 'allowed', domains: [TEST_HOST], maxContentTokens: 10 } });
    const result = await tool.execute({ url: url('/long') });
    expect(result).toContain('truncated to fit the 10-token content budget');
    expect(result.length).toBeLessThan(10 * 4 + 500);
  });

  it('reports a refused request as a tool error, never a fake success', async () => {
    const tool = testTool({ policy: { mode: 'allowed', domains: ['nowhere.test'] } });
    const result = await tool.execute({ url: url('/page') });
    expect(result.startsWith('Error: WebFetch ')).toBe(true);
  });
});

describe('WebFetch content handling', () => {
  it('refuses non-text content with its media type and size, not bytes', async () => {
    const tool = testTool({ policy: undefined });
    const image = await tool.execute({ url: url('/image') });
    expect(image).toContain('cannot convert image/png');
    const pdf = await tool.execute({ url: url('/pdf') });
    expect(pdf).toContain('cannot convert application/pdf');
  });

  it('surfaces an upstream HTTP error status as a tool error', async () => {
    const tool = testTool({ policy: undefined });
    expect(await tool.execute({ url: url('/error') })).toContain('received HTTP 500');
  });

  it('refuses malformed, credential-bearing, and non-HTTP URLs', async () => {
    const tool = testTool({ policy: undefined });
    expect(await tool.execute({ url: 'not a url' })).toContain('not a valid absolute URL');
    expect(await tool.execute({ url: '' })).toContain('non-empty url');
    expect(await tool.execute({ url: `http://user:pass@${TEST_HOST}:${port}/page` })).toContain('must not embed credentials');
    expect(await tool.execute({ url: 'ftp://example.com/file' })).toContain('refuses ftp:');
    expect(await tool.execute({ url: 'file:///etc/passwd' })).toContain('refuses file:');
  });
});

describe('WebFetch credential redaction', () => {
  it('runs page text through the session redactor before the model sees it', async () => {
    const tool = testTool({
      policy: undefined,
      redact: (value) => (typeof value === 'string'
        ? value.split(SECRET).join('[REDACTED]')
        : value),
    });
    const result = await tool.execute({ url: url('/secret') });
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain(SECRET);
  });
});

describe('extractHtmlText closing-tag tolerance', () => {
  // CodeQL flagged the previous `\\s*` closing pattern: a page that emits
  // `</script\t\n bar>` or `</style foo>` slipped its body into the text the
  // model reads, which is both a correctness and a prompt-injection surface.
  const cases: Array<[string, string]> = [
    ['script with whitespace and a stray attribute', '<p>ok</p><script\t\n bar>secret()</script\t\n bar>'],
    ['style with a stray attribute', '<p>ok</p><style foo>body{color:red}</style foo>'],
    ['title with a stray attribute', '<title foo>t</title foo><p>ok</p>'],
  ];

  for (const [label, html] of cases) {
    it(`drops the element body for a ${label}`, () => {
      const text = extractHtmlText(html);
      expect(text).toContain('ok');
      expect(text).not.toContain('secret()');
      expect(text).not.toContain('color:red');
    });
  }

  it('still drops an ordinary closing tag', () => {
    expect(extractHtmlText('<p>ok</p><script>secret()</script>')).not.toContain('secret()');
  });
});

describe('domain policy helpers', () => {
  it('matches exact hosts and subdomains only', () => {
    expect(domainMatchesList('example.com', ['example.com'])).toBe(true);
    expect(domainMatchesList('a.example.com', ['example.com'])).toBe(true);
    expect(domainMatchesList('notexample.com', ['example.com'])).toBe(false);
    expect(domainMatchesList('example.com', ['a.example.com'])).toBe(false);
  });

  it('refuses internal names and allowlist-incompatible IP literals', () => {
    expect(hostPolicyRefusal('localhost', undefined)).toContain('internal name');
    expect(hostPolicyRefusal('cache.internal', undefined)).toContain('internal name');
    expect(hostPolicyRefusal('127.0.0.1', { mode: 'allowed', domains: ['example.com'] })).toContain('IP address');
    expect(hostPolicyRefusal('127.0.0.1', undefined)).toBeUndefined();
    expect(hostPolicyRefusal('example.com', undefined)).toBeUndefined();
  });
});
