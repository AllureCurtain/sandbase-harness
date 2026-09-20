/**
 * WebFetch execution (CMA `web_fetch` built-in tool).
 *
 * This is the runtime half of the tool that `web-tool-policy.ts` only
 * validates: an agent that enables `web_fetch` now actually fetches, but
 * strictly inside these boundaries, in order of precedence:
 *
 * 1. URL shape — only `http:` and `https:`, no embedded credentials, and a
 *    length cap. A malformed or exotic URL is a refusal, not a request.
 * 2. Internal host names — `localhost` and the `.local` / `.internal` /
 *    `.localhost` / `.localdomain` / `.invalid` family are refused before DNS,
 *    because a resolver can be pointed anywhere.
 * 3. Domain policy — `allowed_domains` (exact host or subdomain) or
 *    `blocked_domains`, exactly the lists the schema validated at ingress.
 *    No list means any public host is reachable.
 * 4. Address guard — every DNS result is checked with `isPrivateAddress`
 *    (loopback, RFC 1918, link-local, CGNAT, IPv6 equivalents), and the
 *    connection is pinned to the validated address through a custom `lookup`.
 *    Pinning is what closes DNS rebinding: the address the guard checked is
 *    the address the socket connects to, so a second resolution cannot
 *    disagree with the first.
 * 5. Redirects — every hop restarts checks 1–4, so a 302 to a forbidden or
 *    internal host is refused at that hop, with a bounded hop count.
 * 6. Response limits — a byte cap aborts oversized bodies, a per-request
 *    timeout bounds slow ones, and only text-like content types are decoded;
 *    binary content is reported as its media type and size, never inlined.
 * 7. Context limits — the extracted text is capped by `max_content_tokens`
 *    (a chars-per-token estimate, documented as such) before it reaches the
 *    model, and the result passes through the session's credential redactor,
 *    so a secret echoed by the page still cannot reach the event log.
 *
 * Failures return an `Error: ...` result string — the same shape every other
 * built-in tool uses — so the model sees a real tool error rather than a fake
 * success, and the strategy persists it as a normal `agent.tool_result`.
 *
 * `WebFetchOverrides` exists for tests: a suite that stands up a local HTTP
 * server needs `webfetch.test` to resolve to 127.0.0.1. The override surface
 * is constructor-level only — an agent definition cannot reach it — so no
 * model-facing or API-facing input can relax the guard.
 */

import { randomUUID } from 'node:crypto';
import { lookup as systemDnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import type { WebToolPolicy } from '@/core/agent/web-tool-policy.js';
import { isBlockedInternalHostname, isPrivateAddress } from './address-policy.js';

export const WEB_FETCH_TIMEOUT_MS = 30_000;
export const WEB_FETCH_MAX_RESPONSE_BYTES = 2_000_000;
export const WEB_FETCH_MAX_REDIRECTS = 5;
export const WEB_FETCH_DEFAULT_MAX_CONTENT_TOKENS = 8_000;
/** Rough context-size estimate; 4 chars/token is an approximation, not a tokenizer. */
export const WEB_FETCH_CHARS_PER_TOKEN = 4;

const USER_AGENT = 'sandbase-harness-webfetch/1.0';
const MAX_URL_LENGTH = 2048;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Seam for tests and embedders; absent keeps every production guard on. */
export interface WebFetchOverrides {
  /** Resolve a hostname to its addresses. Defaults to the system resolver. */
  lookupAddresses?: (hostname: string) => Promise<string[]>;
  /** Whether a validated target address may be connected to. Defaults to rejecting private ranges. */
  isAddressAllowed?: (address: string) => boolean;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxRedirects?: number;
}

export interface WebFetchToolOptions {
  /** Resolved `allowed_domains` / `blocked_domains` / `max_content_tokens` for this agent. */
  policy?: WebToolPolicy;
  /** The session's credential redactor; applied to the final result text. */
  redact?: (value: unknown) => unknown;
  overrides?: WebFetchOverrides;
}

/** A refusal the model must see as a tool error; never thrown past `execute`. */
class WebFetchRefusal extends Error {}

/** True when `host` is the entry itself or a subdomain of it. Entries are pre-normalized by the policy validator. */
export function domainMatchesList(host: string, domains: readonly string[]): boolean {
  return domains.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

/**
 * Host-level checks that must hold before any address is consulted, given the
 * tool's domain policy. Returns a refusal message or `undefined`.
 */
export function hostPolicyRefusal(host: string, policy?: WebToolPolicy): string | undefined {
  if (isBlockedInternalHostname(host)) {
    return `target host "${host}" is an internal name and is not reachable from this runtime`;
  }
  if (net.isIP(host)) {
    // IP literals cannot match a domain list, so an allowlist mode ends here.
    if (policy?.mode === 'allowed') {
      return `target "${host}" is an IP address, which cannot appear in allowed_domains`;
    }
    return undefined;
  }
  if (policy?.mode === 'allowed' && !domainMatchesList(host, policy.domains)) {
    return `host "${host}" is not covered by the agent's allowed_domains`;
  }
  if (policy?.mode === 'blocked' && domainMatchesList(host, policy.domains)) {
    return `host "${host}" is listed in the agent's blocked_domains`;
  }
  return undefined;
}

export function createWebFetchTool(options: WebFetchToolOptions) {
  const {
    lookupAddresses = defaultLookupAddresses,
    isAddressAllowed = (address: string) => !isPrivateAddress(address),
    timeoutMs = WEB_FETCH_TIMEOUT_MS,
    maxResponseBytes = WEB_FETCH_MAX_RESPONSE_BYTES,
    maxRedirects = WEB_FETCH_MAX_REDIRECTS,
  } = options.overrides ?? {};

  return {
    description: 'Fetch a web page over HTTP/HTTPS and return its extracted text. Subject to the agent domain policy and private-network restrictions.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL to fetch' },
      },
      required: ['url'],
    },
    execute: async ({ url }: { url?: unknown }) => {
      const redact = options.redact ?? ((value: unknown) => value);
      try {
        const document = await fetchDocument(String(url ?? ''), {
          policy: options.policy,
          lookupAddresses,
          isAddressAllowed,
          timeoutMs,
          maxResponseBytes,
          maxRedirects,
        });
        return String(redact(renderResult(document, options.policy)));
      } catch (err) {
        const message = err instanceof WebFetchRefusal
          ? err.message
          : `unexpected failure: ${err instanceof Error ? err.message : String(err)}`;
        return String(redact(`Error: WebFetch ${message}`));
      }
    },
  };
}

interface FetchLimits {
  policy?: WebToolPolicy;
  lookupAddresses: (hostname: string) => Promise<string[]>;
  isAddressAllowed: (address: string) => boolean;
  timeoutMs: number;
  maxResponseBytes: number;
  maxRedirects: number;
}

interface FetchedDocument {
  url: URL;
  statusCode: number;
  mediaType: string;
  byteLength: number;
  title: string | undefined;
  text: string;
}

async function fetchDocument(rawUrl: string, limits: FetchLimits): Promise<FetchedDocument> {
  const trimmed = rawUrl.trim();
  if (!trimmed) throw new WebFetchRefusal('requires a non-empty url argument');
  if (trimmed.length > MAX_URL_LENGTH) throw new WebFetchRefusal(`url is longer than ${MAX_URL_LENGTH} characters`);
  let current: URL;
  try {
    current = new URL(trimmed);
  } catch {
    throw new WebFetchRefusal(`"${trimmed}" is not a valid absolute URL`);
  }

  for (let hop = 0; ; hop += 1) {
    assertUrlShape(current);
    const host = bareHostname(current);
    const policyProblem = hostPolicyRefusal(host, limits.policy);
    if (policyProblem) throw new WebFetchRefusal(policyProblem);
    const address = await resolveAllowedAddress(host, limits);

    const response = await requestOnce(current, address, limits);
    if (REDIRECT_STATUSES.has(response.statusCode) && response.location) {
      if (hop >= limits.maxRedirects) {
        throw new WebFetchRefusal(`exceeded ${limits.maxRedirects} redirects`);
      }
      try {
        current = new URL(response.location, current);
      } catch {
        throw new WebFetchRefusal(`redirect target from ${host} is not a valid URL`);
      }
      continue;
    }

    if (response.statusCode >= 400) {
      throw new WebFetchRefusal(`received HTTP ${response.statusCode} from ${host}`);
    }
    const mediaType = mediaTypeOf(response.contentType);
    if (!isTextualMedia(mediaType)) {
      throw new WebFetchRefusal(
        `cannot convert ${mediaType || 'unknown'} content (${response.body.length} bytes) from ${host} into text`,
      );
    }
    const decoded = response.body.toString('utf8');
    const looksLikeHtml = mediaType.includes('html') || (mediaType === '' && /^\s*<(html|!doctype)/i.test(decoded));
    const extracted = looksLikeHtml ? extractHtmlText(decoded) : collapseBlankLines(decoded.trim());
    return {
      url: current,
      statusCode: response.statusCode,
      mediaType,
      byteLength: response.body.length,
      title: looksLikeHtml ? extractTitle(decoded) : undefined,
      text: extracted,
    };
  }
}

function assertUrlShape(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebFetchRefusal(`refuses ${url.protocol} URLs; only http and https are supported`);
  }
  if (url.username || url.password) {
    throw new WebFetchRefusal('url must not embed credentials');
  }
  if (!url.hostname) {
    throw new WebFetchRefusal('url has no host');
  }
}

/** URL.hostname keeps brackets around IPv6 literals; net.connect wants them gone. */
function bareHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
}

async function resolveAllowedAddress(host: string, limits: FetchLimits): Promise<string> {
  if (net.isIP(host)) {
    if (!limits.isAddressAllowed(host)) {
      throw new WebFetchRefusal(`address "${host}" is a private or non-routable target`);
    }
    return host;
  }
  let addresses: string[];
  try {
    addresses = await limits.lookupAddresses(host);
  } catch {
    throw new WebFetchRefusal(`could not resolve "${host}"`);
  }
  if (addresses.length === 0) throw new WebFetchRefusal(`"${host}" resolved to no address`);
  const blocked = addresses.find((address) => !limits.isAddressAllowed(address));
  if (blocked) {
    throw new WebFetchRefusal(`"${host}" resolves to the private or non-routable address "${blocked}"`);
  }
  return addresses.find((address) => !address.includes(':')) ?? addresses[0];
}

interface RawResponse {
  statusCode: number;
  contentType: string;
  location: string | undefined;
  body: Buffer;
}

async function requestOnce(url: URL, pinnedAddress: string, limits: FetchLimits): Promise<RawResponse> {
  const isHttps = url.protocol === 'https:';
  const client = isHttps ? https : http;
  const requestId = randomUUID().slice(0, 8);
  const port = url.port ? Number(url.port) : undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.timeoutMs);

  return new Promise<RawResponse>((resolve, reject) => {
    const request = client.request(
      {
        // The socket is opened against the validated address...
        host: pinnedAddress,
        hostname: pinnedAddress,
        port,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        agent: false,
        // ...while these keep the request itself addressed to the real host.
        headers: {
          host: url.host,
          'user-agent': `${USER_AGENT} req:${requestId}`,
          accept: 'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.1',
          'accept-encoding': 'identity',
        },
        // An IPv6 literal cannot be a TLS SNI name; for names, Node derives
        // servername from `host`, which would now be the IP — so set it
        // explicitly whenever TLS is involved and the host is a name. The
        // paired `checkServerIdentity` keeps certificate verification bound to
        // the real hostname rather than the pinned address; verification is
        // never disabled.
        ...(isHttps && !net.isIP(url.hostname)
          ? {
            servername: url.hostname,
            checkServerIdentity: (host: string, cert: tls.PeerCertificate) =>
              tls.checkServerIdentity(url.hostname, cert),
          }
          : {}),
        signal: controller.signal,
        // Without a custom lookup Node would resolve the hostname again —
        // the rebinding window. This returns only the address already checked.
        lookup: (_host: string, _options: unknown, callback: unknown) => {
          const cb = (typeof _options === 'function' ? _options : callback) as (
            err: Error | null,
            address?: string | { address: string; family: number }[],
            family?: number,
          ) => void;
          const options = (typeof _options === 'object' && _options !== null ? _options : {}) as { all?: boolean; family?: number };
          const family = pinnedAddress.includes(':') ? 6 : 4;
          if (options.family && options.family !== family) {
            cb(Object.assign(new Error('validated address family mismatch'), { code: 'EAI_FAMILY' }));
            return;
          }
          if (options.all) cb(null, [{ address: pinnedAddress, family }]);
          else cb(null, pinnedAddress, family);
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let received = 0;
        const fail = (err: Error) => {
          response.destroy();
          clearTimeout(timer);
          reject(err);
        };
        response.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > limits.maxResponseBytes) {
            fail(new WebFetchRefusal(
              `response from ${bareHostname(url)} exceeds the ${limits.maxResponseBytes}-byte limit`,
            ));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          clearTimeout(timer);
          resolve({
            statusCode: response.statusCode ?? 0,
            contentType: String(response.headers['content-type'] ?? ''),
            location: typeof response.headers.location === 'string' ? response.headers.location : undefined,
            body: Buffer.concat(chunks),
          });
        });
        response.on('error', fail);
      },
    );
    request.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(err.name === 'AbortError' || controller.signal.aborted
        ? new WebFetchRefusal(`request to ${bareHostname(url)} timed out after ${limits.timeoutMs}ms`)
        : new WebFetchRefusal(`connection to ${bareHostname(url)} failed: ${err.message}`));
    });
    request.end();
  });
}

function renderResult(document: FetchedDocument, policy?: WebToolPolicy): string {
  const maxTokens = policy?.maxContentTokens ?? WEB_FETCH_DEFAULT_MAX_CONTENT_TOKENS;
  const budgetChars = maxTokens * WEB_FETCH_CHARS_PER_TOKEN;
  const truncated = document.text.length > budgetChars;
  const text = truncated ? `${document.text.slice(0, budgetChars)}\n\n[Content truncated to fit the ${maxTokens}-token content budget.]` : document.text;
  const lines = [
    `URL: ${document.url.href}`,
    `Status: ${document.statusCode}`,
    `Content-Type: ${document.mediaType || 'unknown'}`,
  ];
  if (document.title) lines.push(`Title: ${document.title}`);
  return `${lines.join('\n')}\n\n${text || '[The page contained no extractable text.]'}`;
}

function mediaTypeOf(contentType: string): string {
  return contentType.split(';')[0].trim().toLowerCase();
}

const TEXTUAL_MEDIA_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/xhtml+xml',
  'application/xml',
  'application/javascript',
  'application/x-javascript',
  'application/yaml',
  'application/x-yaml',
  'application/toml',
]);

function isTextualMedia(mediaType: string): boolean {
  return mediaType.startsWith('text/')
    || TEXTUAL_MEDIA_TYPES.has(mediaType)
    || mediaType.endsWith('+json')
    || mediaType.endsWith('+xml');
}

/** Strip scripts, styles, and markup; collapse whitespace; decode common entities. */
export function extractHtmlText(html: string): string {
  // The closing tags are matched with `[^>]*` rather than `\s*` on purpose: a
  // real page can emit `</script\t\n bar>` or `</style foo>`, and a pattern
  // that only accepts trailing whitespace leaves the element's body in the
  // text handed to the model.
  const withoutMarkup = html
    .replace(/<script\b[\s\S]*?<\/script[^>]*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style[^>]*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<title\b[\s\S]*?<\/title[^>]*>/gi, ' ')
    .replace(/<\/?(?:p|div|li|ul|ol|h[1-6]|tr|table|section|article|blockquote|pre)[^>]*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');
  return collapseBlankLines(decodeEntities(withoutMarkup));
}

function extractTitle(html: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  if (!match) return undefined;
  const title = collapseBlankLines(decodeEntities(match[1].replace(/<[^>]*>/g, ' '))).trim();
  return title ? title.slice(0, 300) : undefined;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, digits: string) => safeFromCodePoint(Number(digits)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#0*39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function safeFromCodePoint(code: number): string {
  return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
    ? String.fromCodePoint(code)
    : '?';
}

function collapseBlankLines(value: string): string {
  return value
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function defaultLookupAddresses(hostname: string): Promise<string[]> {
  const entries = await systemDnsLookup(hostname, { all: true, verbatim: true });
  return entries.map((entry) => entry.address);
}
