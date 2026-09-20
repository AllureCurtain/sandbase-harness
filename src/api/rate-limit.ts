/**
 * In-process inbound rate limiting for the /v1 surface.
 *
 * This is a modest, single-process fixed-window guard. It is not distributed
 * storage or a DDoS boundary. Authenticated callers use credential buckets;
 * open local runtimes are unlimited by default unless explicitly enabled.
 */

import { randomBytes, scryptSync } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';

const BUCKET_SECRET = randomBytes(32);

export interface InboundRateLimitOverrides {
  enabled?: boolean;
  readPerMinute?: number;
  writePerMinute?: number;
}

export interface InboundRateLimitPolicy {
  enabled: boolean;
  readPerMinute: number;
  writePerMinute: number;
  /** Re-evaluates the default auth posture when managed keys change. */
  shouldLimit?: () => boolean;
}

export const INBOUND_RATE_LIMIT_DEFAULTS = {
  readPerMinute: 1200,
  writePerMinute: 300,
} as const;

type AuthPosture = boolean | (() => boolean);

/** Resolve explicit override, environment, then the current auth posture. */
export function resolveInboundRateLimitPolicy(
  options: InboundRateLimitOverrides & { authEnabled: AuthPosture; env?: NodeJS.ProcessEnv },
): InboundRateLimitPolicy {
  const env = options.env ?? process.env;
  const envEnabled = parseToggle(env.MANAGED_AGENTS_INBOUND_RATE_LIMIT);
  const explicitEnabled = options.enabled ?? envEnabled;
  const currentAuthEnabled = typeof options.authEnabled === 'function' ? options.authEnabled() : options.authEnabled;
  return {
    enabled: explicitEnabled ?? currentAuthEnabled,
    shouldLimit: () => explicitEnabled ?? (typeof options.authEnabled === 'function' ? options.authEnabled() : options.authEnabled),
    readPerMinute: positiveInt(
      options.readPerMinute ?? positiveInt(env.MANAGED_AGENTS_INBOUND_RATE_LIMIT_READ),
      INBOUND_RATE_LIMIT_DEFAULTS.readPerMinute,
    ),
    writePerMinute: positiveInt(
      options.writePerMinute ?? positiveInt(env.MANAGED_AGENTS_INBOUND_RATE_LIMIT_WRITE),
      INBOUND_RATE_LIMIT_DEFAULTS.writePerMinute,
    ),
  };
}

export interface InboundRateLimiter {
  middleware: MiddlewareHandler;
  used(identity: string, kind: 'read' | 'write', now?: number): number;
}

export function createInboundRateLimiter(
  policy: InboundRateLimitPolicy,
  now: () => number = Date.now,
): InboundRateLimiter {
  let windowStart = 0;
  let counters = new Map<string, number>();

  const countFor = (identity: string, kind: 'read' | 'write') => counters.get(`${identity}:${kind}`) ?? 0;

  const middleware: MiddlewareHandler = async (c, next) => {
    // CORS handles OPTIONS before this route middleware. Keep preflight out of
    // the contract even when a caller mounts this middleware directly.
    if (!(policy.shouldLimit?.() ?? policy.enabled)
      || c.req.method.toUpperCase() === 'OPTIONS'
      || c.req.path.startsWith('/v1/x/health')) {
      return next();
    }

    const kind = requestKind(c.req.method);
    const limit = kind === 'read' ? policy.readPerMinute : policy.writePerMinute;
    const current = now();
    const start = Math.floor(current / 60_000) * 60_000;
    if (start !== windowStart) {
      windowStart = start;
      counters = new Map();
    }

    const identity = callerIdentity(c);
    const key = `${identity}:${kind}`;
    const used = countFor(identity, kind);
    const retryAfterSeconds = Math.max(1, Math.ceil((windowStart + 60_000 - current) / 1000));

    if (used >= limit) {
      return c.json(
        {
          error: {
            type: 'rate_limit_error',
            code: 'inbound_rate_limited',
            message: `Too many ${kind} requests. Limit is ${limit} per minute; retry in ${retryAfterSeconds}s.`,
          },
        },
        429,
        {
          'Retry-After': String(retryAfterSeconds),
          'X-RateLimit-Limit': String(limit),
          'X-RateLimit-Remaining': '0',
        },
      );
    }

    counters.set(key, used + 1);
    await next();
    c.header('X-RateLimit-Limit', String(limit));
    c.header('X-RateLimit-Remaining', String(Math.max(0, limit - used - 1)));
  };

  return {
    middleware,
    used: (identity, kind, at) => {
      if (at !== undefined && Math.floor(at / 60_000) * 60_000 !== windowStart) return 0;
      return countFor(identity, kind);
    },
  };
}

/** GET/HEAD are reads; OPTIONS is a CORS preflight and is not counted. */
export function requestKind(method: string): 'read' | 'write' {
  const upper = method.toUpperCase();
  return upper === 'GET' || upper === 'HEAD' || upper === 'OPTIONS' ? 'read' : 'write';
}

/** Derive credential identity with a process-random salt; raw keys never enter bucket identifiers. */
export function callerIdentity(c: Context): string {
  const token = bearerToken(c.req.header('Authorization')) ?? c.req.header('x-api-key')?.trim();
  if (token) return `key:${scryptSync(token, BUCKET_SECRET, 16).toString('hex')}`;
  const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
  return `ip:${forwarded || c.req.header('x-real-ip')?.trim() || 'local'}`;
}

function bearerToken(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined;
  return /^Bearer\s+(.+)$/i.exec(authorization)?.[1]?.trim();
}

function parseToggle(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (['on', 'true', '1', 'yes', 'enabled'].includes(normalized)) return true;
  if (['off', 'false', '0', 'no', 'disabled'].includes(normalized)) return false;
  return undefined;
}

function positiveInt(value: string | number | undefined): number | undefined;
function positiveInt(value: string | number | undefined, fallback: number): number;
function positiveInt(value: string | number | undefined, fallback?: number): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
