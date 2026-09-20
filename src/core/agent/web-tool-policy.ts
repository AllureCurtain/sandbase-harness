/**
 * Web tool domain-list policy (CMA `allowed_domains` / `blocked_domains`).
 *
 * The published contract keeps two questions separate, and so does this module:
 *
 * 1. Can the configuration be *expressed*? Domain lists follow a published
 *    grammar, and a definition that violates it is malformed regardless of
 *    whether this runtime can execute web tools. It must be rejected at the
 *    same entry points the contract names (agent create/update, session
 *    create/update) with a 400 `invalid_request_error`.
 * 2. Can the configuration be *executed*? `web_fetch` executes through the
 *    WebFetch tool in `core/web/web-fetch.ts`, which consumes the resolved
 *    lists via {@link resolveWebToolExecutionPolicy}. `web_search` has no
 *    search provider, so an enabled entry is still refused by capability
 *    admission. That check lives in the capability registry, not here.
 *
 * Keeping them apart means a malformed list is rejected even on a disabled
 * entry — a broken declaration of intent is still broken — while the
 * execution question is answered separately by the capability registry.
 *
 * Rules implemented from 工具.md §"域名列表规则" (`claude-managed-agents-docs`):
 * - One of `allowed_domains` / `blocked_domains` per entry, never both.
 * - 1–64 domains per list, each 1–255 characters; an empty list is rejected.
 * - Plain hostname: ASCII letters, digits, hyphens, underscores, dots. No
 *   scheme, port, credentials, wildcard, or whitespace. No label may start or
 *   end with a hyphen. No path, except the `web_search` suffix noted below.
 * - Any IP address form is rejected, including bracketed IPv6 and numeric
 *   shorthand such as `127.1`.
 * - Bare top-level domains and registry suffixes (`com`, `co.uk`, `gov.uk`)
 *   and single-label names (`intranet`) are rejected.
 * - `localhost` and hosts under `.localhost`, `.local`, `.internal`,
 *   `.localdomain`, `.invalid` are rejected.
 * - Non-ASCII hosts are rejected; use the `xn--` Punycode form.
 * - `web_fetch` domains cannot carry a path; `web_search` may carry one suffix
 *   without whitespace or any of `? # $ , | ^ !`.
 * - Duplicate domains within one list are rejected. Comparison is
 *   case-insensitive and ignores a single trailing `/`, and subdomains are
 *   distinct entries, so `www.example.com` does not stand in for
 *   `example.com`.
 *
 * Deliberately NOT enforced here: whether a domain is reachable by the search
 * or fetch provider, whether a `user_location.country` is supported, and
 * whether a `user_location.timezone` is a real IANA name. Those depend on a
 * live upstream provider this runtime does not contact, so claiming to validate
 * them would be a guess dressed as a check.
 */

import { z } from 'zod';
import type { AgentToolset } from '@/types/agent.js';

/** The only tool names that accept domain lists. */
export const WEB_TOOL_NAMES = ['web_fetch', 'web_search'] as const;
export type WebToolName = (typeof WEB_TOOL_NAMES)[number];

export const MAX_DOMAINS_PER_LIST = 64;
export const MAX_DOMAIN_LENGTH = 255;

/** Rejected host suffixes, matching the published list. */
const REJECTED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.invalid'] as const;

/**
 * Suffixes that look like a TLD but never are. A single-label name is rejected
 * on its own (see `isSingleLabel`), so only multi-label public suffixes that
 * cannot be registered by themselves need listing.
 */
const RESERVED_REGISTRY_SUFFIXES = new Set([
  'co.uk',
  'gov.uk',
  'ac.uk',
  'org.uk',
  'com.au',
  'net.au',
  'org.au',
  'co.jp',
  'co.nz',
  'com.br',
  'co.in',
  'com.cn',
  'co.kr',
  'com.hk',
]);

/** Default web-tool domains policy when a config declares neither list. */
export type WebToolDomainMode = 'allowed' | 'blocked';

export interface WebToolPolicy {
  /** Which list the entry declared, if either. */
  mode?: WebToolDomainMode;
  /** Normalized domains (lowercased, trailing slash stripped), in input order. */
  domains: string[];
  /** `web_fetch` content limit; only `web_fetch` accepts it. */
  maxContentTokens?: number;
  /** `web_search` localization; only `web_search` accepts it. */
  userLocation?: WebUserLocation;
}

export interface WebUserLocation {
  type?: string;
  country?: string;
  timezone?: string;
}

export interface WebToolValidationError {
  /** Dotted path including the list name and zero-based index, e.g. `allowed_domains.0`. */
  path: string;
  message: string;
}

// ============================================================
// Hostname shape
// ============================================================

/** IPv4 in dotted decimal, including the `127.1` shorthand the contract names. */
function looksLikeIpv4(value: string): boolean {
  const bare = value.replace(/\.$/, '');
  if (!/^[0-9.]+$/.test(bare)) return false;
  const parts = bare.split('.');
  if (parts.length < 2 || parts.length > 4) return false;
  return parts.every((part) => part.length > 0 && part.length <= 3 && Number(part) <= 255);
}

/** IPv6, with or without brackets, and IPv4-mapped forms. */
function looksLikeIpv6(value: string): boolean {
  const bare = value.replace(/^\[|\]$/g, '');
  if (!bare.includes(':')) return false;
  return /^[0-9a-fA-F:.]+$/.test(bare);
}

function isSingleLabel(value: string): boolean {
  return !value.includes('.');
}

function isRejectedHost(value: string): boolean {
  if (value === 'localhost') return true;
  return REJECTED_HOST_SUFFIXES.some((suffix) => value.endsWith(suffix));
}

/**
 * Validate one hostname (already lowercased, trailing `/` removed).
 * Returns an error message, or `undefined` when the host is acceptable.
 *
 * `allowPath` is true only for `web_search`, whose grammar permits one path
 * suffix used as a URL pattern by the search provider.
 */
function hostnameError(host: string, allowPath: boolean): string | undefined {
  if (host.length === 0) return 'Domain must not be empty';
  if (host.length > MAX_DOMAIN_LENGTH) {
    return `Domain must be at most ${MAX_DOMAIN_LENGTH} characters`;
  }

  let hostPart = host;
  if (host.includes('/')) {
    if (!allowPath) {
      return 'Domain must not include a path; provide a plain hostname like "example.com"';
    }
    const slash = host.indexOf('/');
    hostPart = host.slice(0, slash);
    const path = host.slice(slash + 1);
    if (path.length === 0) return 'Domain path must not be empty';
    if (/[\s?#$,|^!]/.test(path)) {
      return 'Domain path must not contain whitespace or any of ? # $ , | ^ !';
    }
    if (hostPart.length === 0) return 'Domain must include a hostname before the path';
  }

  if (/\s/.test(hostPart)) return 'Domain must not contain whitespace';
  if (hostPart.includes(':')) {
    return 'Domain must not include a port; provide a plain hostname like "example.com"';
  }
  if (hostPart.startsWith('*') || hostPart.includes('*')) {
    return 'Domain must not be a wildcard; provide a plain hostname like "example.com"';
  }
  if (hostPart.includes('@')) {
    return 'Domain must not include credentials; provide a plain hostname like "example.com"';
  }
  if (looksLikeIpv4(hostPart) || looksLikeIpv6(hostPart)) {
    return 'IP addresses are not supported; provide a plain hostname like "example.com"';
  }
  if (isRejectedHost(hostPart)) {
    return 'Domain is not routable; provide a public hostname like "example.com"';
  }
  if (!/^[a-z0-9._-]+$/.test(hostPart)) {
    return 'Domain must be ASCII; use the xn-- Punycode form for internationalized names';
  }
  if (hostPart.startsWith('.') || hostPart.endsWith('.')) {
    return 'Domain must not start or end with a dot';
  }
  if (hostPart.includes('..')) return 'Domain must not contain consecutive dots';
  if (isSingleLabel(hostPart)) {
    return 'Domain must be a fully qualified name; single-label names are not supported';
  }
  if (RESERVED_REGISTRY_SUFFIXES.has(hostPart)) {
    return 'Domain must not be a registry suffix; provide a full domain like "example.co.uk"';
  }
  for (const label of hostPart.split('.')) {
    if (label.length === 0) return 'Domain must not contain empty labels';
    if (label.startsWith('-') || label.endsWith('-')) {
      return 'Domain labels must not start or end with a hyphen';
    }
  }
  return undefined;
}

/** Canonical form used for duplicate detection and storage. */
function normalizeDomain(value: string): string {
  return value.toLowerCase().replace(/\/$/, '');
}

// ============================================================
// Entry validation
// ============================================================

function isWebToolName(name: unknown): name is WebToolName {
  return typeof name === 'string' && (WEB_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * Validate one web-tool config entry.
 *
 * `pathPrefix` is the dotted location of the entry, e.g. `tools.0.configs.1`,
 * so messages name the exact list and index the contract requires.
 */
function webToolEntryErrors(
  config: Record<string, unknown>,
  pathPrefix: string,
): WebToolValidationError[] {
  const errors: WebToolValidationError[] = [];
  const name = config.name as string;
  const isFetch = name === 'web_fetch';

  const allowed = config.allowed_domains;
  const blocked = config.blocked_domains;
  const hasAllowed = allowed !== undefined && allowed !== null;
  const hasBlocked = blocked !== undefined && blocked !== null;

  if (hasAllowed && hasBlocked) {
    errors.push({
      path: pathPrefix,
      message: 'Only one of allowed_domains or blocked_domains may be set.',
    });
  }

  for (const [listName, raw] of [['allowed_domains', allowed], ['blocked_domains', blocked]] as const) {
    if (raw === undefined || raw === null) continue;
    const listPath = `${pathPrefix}.${listName}`;
    if (!Array.isArray(raw)) {
      errors.push({ path: listPath, message: `${listName} must be an array of domains or null` });
      continue;
    }
    if (raw.length === 0) {
      errors.push({
        path: listPath,
        message: `${listName}: Empty list of domains is ambiguous. Provide at least one domain or null.`,
      });
      continue;
    }
    if (raw.length > MAX_DOMAINS_PER_LIST) {
      errors.push({
        path: listPath,
        message: `${listName}: A list may contain at most ${MAX_DOMAINS_PER_LIST} domains`,
      });
      continue;
    }

    const seen = new Set<string>();
    raw.forEach((entry, index) => {
      const entryPath = `${listPath}.${index}`;
      if (typeof entry !== 'string') {
        errors.push({ path: entryPath, message: 'Domain must be a string' });
        return;
      }
      const normalized = normalizeDomain(entry);
      if (seen.has(normalized)) {
        errors.push({ path: entryPath, message: `Duplicate domain "${entry}" in ${listName}` });
        return;
      }
      seen.add(normalized);
      const problem = hostnameError(normalized, !isFetch);
      if (problem) errors.push({ path: entryPath, message: problem });
    });
  }

  if (config.max_content_tokens !== undefined) {
    if (!isFetch) {
      errors.push({
        path: `${pathPrefix}.max_content_tokens`,
        message: 'max_content_tokens is only supported on web_fetch',
      });
    } else if (
      typeof config.max_content_tokens !== 'number'
      || !Number.isInteger(config.max_content_tokens)
      || config.max_content_tokens <= 0
    ) {
      errors.push({
        path: `${pathPrefix}.max_content_tokens`,
        message: 'max_content_tokens must be a positive integer',
      });
    }
  }

  if (config.user_location !== undefined) {
    if (isFetch) {
      errors.push({
        path: `${pathPrefix}.user_location`,
        message: 'user_location is only supported on web_search',
      });
    } else {
      const location = config.user_location;
      if (!location || typeof location !== 'object' || Array.isArray(location)) {
        errors.push({
          path: `${pathPrefix}.user_location`,
          message: 'user_location must be an object',
        });
      } else {
        const record = location as Record<string, unknown>;
        for (const key of ['type', 'country', 'timezone'] as const) {
          const value = record[key];
          if (value !== undefined && typeof value !== 'string') {
            errors.push({
              path: `${pathPrefix}.user_location.${key}`,
              message: `user_location.${key} must be a string`,
            });
          }
        }
      }
    }
  }

  return errors;
}

/**
 * Validate every web-tool entry in an agent definition's `tools` array.
 *
 * Walked structurally rather than through the Zod schema so the error paths
 * and messages match the published wording exactly; a Zod issue list would
 * flatten the list/index information the contract makes normative.
 */
export function validateWebToolConfigs(tools: unknown): WebToolValidationError[] {
  if (!Array.isArray(tools)) return [];
  const errors: WebToolValidationError[] = [];

  tools.forEach((toolset, toolsetIndex) => {
    if (!toolset || typeof toolset !== 'object' || Array.isArray(toolset)) return;
    const configs = (toolset as Record<string, unknown>).configs;
    if (!Array.isArray(configs)) return;

    configs.forEach((config, configIndex) => {
      if (!config || typeof config !== 'object' || Array.isArray(config)) return;
      const record = config as Record<string, unknown>;
      if (!isWebToolName(record.name)) return;
      errors.push(...webToolEntryErrors(record, `tools.${toolsetIndex}.configs.${configIndex}`));
    });
  });

  return errors;
}

/** True when the entry declares any web-tool policy field. */
export function hasWebToolPolicy(config: Record<string, unknown>): boolean {
  return (
    config.allowed_domains !== undefined
    || config.blocked_domains !== undefined
    || config.max_content_tokens !== undefined
    || config.user_location !== undefined
  );
}

// ============================================================
// Schema fragment
// ============================================================

/**
 * Fields shared by both web tools. Declared as a passthrough shape so the
 * structural validator above owns the domain grammar while the schema still
 * types the surrounding toolset. Domain lists stay `unknown[]` here because a
 * Zod `string[]` would emit a generic message that loses the list and index.
 */
export const webToolPolicyFieldsSchema = {
  allowed_domains: z.array(z.unknown()).nullish(),
  blocked_domains: z.array(z.unknown()).nullish(),
  max_content_tokens: z.number().optional(),
  user_location: z
    .object({
      type: z.string().optional(),
      country: z.string().optional(),
      timezone: z.string().optional(),
    })
    .optional(),
} as const;
/**
 * Resolve the *execution* policy for one web tool from an agent definition.
 *
 * The ingress validator guarantees the grammar, so this only normalizes:
 * lowercase, trailing slash removed, first matching config entry wins. A tool
 * with neither list yields `mode: undefined`, which the executor reads as
 * "no domain restriction" — the address guard still applies.
 */
export function resolveWebToolExecutionPolicy(
  agent: { tools?: AgentToolset[] },
  name: WebToolName,
): WebToolPolicy | undefined {
  for (const toolset of agent.tools ?? []) {
    if (toolset.type !== 'agent_toolset_20260401') continue;
    const config = (toolset.configs ?? []).find((entry) => entry.name === name);
    if (!config) continue;
    const allowed = config.allowed_domains ?? undefined;
    const blocked = config.blocked_domains ?? undefined;
    return {
      mode: allowed ? 'allowed' : blocked ? 'blocked' : undefined,
      domains: (allowed ?? blocked ?? []).map((domain) => domain.toLowerCase().replace(/\/$/, '')),
      maxContentTokens: config.max_content_tokens,
    };
  }
  return undefined;
}
