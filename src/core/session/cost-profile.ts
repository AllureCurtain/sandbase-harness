/**
 * Local cost profile.
 *
 * Session budgets are enforced against a **list cost**: an amount of money the
 * runtime attributes to the work a session has already done. The published
 * contract computes it from vendor pricing, which a self-hosted runtime has no
 * authoritative copy of — and inventing plausible-looking dollar figures would
 * make every budget number a lie.
 *
 * So the rates live here, as an explicit operator-supplied profile:
 *
 * - The profile is **empty by default**. A model with no entry in it has no
 *   list price, and a budgeted session that names an unpriced model is refused
 *   with the published "no list price" rejection instead of being metered
 *   against a made-up rate. That refusal is the contract's own behaviour, not a
 *   local shortcut.
 * - Rates are integer **cents per million tokens**, so the arithmetic below is
 *   exact and never touches a float. Enforcement compares the exact microcent
 *   total; the reported `list_cost` is that total rounded to whole cents, which
 *   is the published rounding rule.
 * - Runtime and web-search rates default to `0` rather than to the published
 *   vendor rates. This runtime genuinely does not meter them, and a declared
 *   zero is a true statement about local behaviour in a way that a copied
 *   vendor rate would not be.
 *
 * The profile is configuration, not policy: an operator who wants budgets to
 * track real spend supplies their own negotiated rates through
 * {@link COST_PROFILE_ENV} or {@link parseCostProfile}.
 */

import type { SessionEvent } from '@/types/session.js';

/** Environment variable holding a JSON cost profile. */
export const COST_PROFILE_ENV = 'MANAGED_AGENTS_COST_PROFILE';

/** Integer cents per million tokens for one model. */
export interface ModelListPrice {
  input_per_mtok_cents: number;
  output_per_mtok_cents: number;
  cache_read_per_mtok_cents?: number;
  cache_write_per_mtok_cents?: number;
}

export interface CostProfile {
  /** Operator-visible name, echoed in cost breakdowns so a number can be traced. */
  id: string;
  /** Per-million-token rates, keyed by the model id the runtime records. */
  models: Record<string, ModelListPrice>;
  /** Cents per 1,000 web-search requests. Local default: 0 (not metered). */
  web_search_per_1000_cents: number;
  /** Cents per hour of active session time. Local default: 0 (not metered). */
  active_hour_cents: number;
}

/**
 * The profile used when none is configured.
 *
 * Deliberately has no model rates: "no rate" is how the runtime says "I cannot
 * price this model", which is a different statement from "this model costs
 * nothing".
 */
export const EMPTY_COST_PROFILE: CostProfile = {
  id: 'local',
  models: {},
  web_search_per_1000_cents: 0,
  active_hour_cents: 0,
};

/** One model's share of a session's consumption. */
export interface ModelConsumption {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface CostBreakdown {
  /**
   * Exact cost in microcents (1e-6 cent). Integer at every step, so the
   * between-requests comparison never depends on float rounding.
   */
  microcents: number;
  /** {@link microcents} rounded to whole cents — the reported `list_cost`. */
  cents: number;
  /**
   * Models the profile could not price. Non-empty means the total is a lower
   * bound and the budget can no longer meter the session, which the published
   * contract treats as "remove the budget to continue".
   */
  unpricedModels: string[];
  /** Per-model contributions, for auditing where a number came from. */
  perModel: Array<{ model: string; microcents: number }>;
}

/** Microcents in one cent. */
const MICROCENTS_PER_CENT = 1_000_000;
/** Tokens in one million tokens. */
const TOKENS_PER_MTOK = 1_000_000;
/** Seconds in one hour. */
const SECONDS_PER_HOUR = 3600;

/**
 * Price one model's token consumption.
 *
 * `tokens * rate` is already microcents, because `rate` is cents per million
 * tokens and microcents are millionths of a cent: the two million-factors
 * cancel. Keeping that identity explicit is what removes the float.
 */
function modelMicrocents(consumption: ModelConsumption, price: ModelListPrice): number {
  const cacheRead = consumption.cacheReadTokens ?? 0;
  const cacheWrite = consumption.cacheWriteTokens ?? 0;
  // Unlisted cache rates fall back to the input rate: caching changes how many
  // tokens were billed, not what one token costs, and treating a cache read as
  // free would under-report spend.
  const cacheReadRate = price.cache_read_per_mtok_cents ?? price.input_per_mtok_cents;
  const cacheWriteRate = price.cache_write_per_mtok_cents ?? price.input_per_mtok_cents;

  return consumption.inputTokens * price.input_per_mtok_cents
    + consumption.outputTokens * price.output_per_mtok_cents
    + cacheRead * cacheReadRate
    + cacheWrite * cacheWriteRate;
}

/**
 * Turn a profile and a set of consumptions into a cost.
 *
 * `activeSeconds` and `webSearchRequests` are priced from the profile's own
 * rates, so a profile that declares them zero produces zero rather than the
 * published vendor rate.
 */
export function computeCost(
  profile: CostProfile,
  consumptions: readonly ModelConsumption[],
  extra: { activeSeconds?: number; webSearchRequests?: number } = {},
): CostBreakdown {
  const unpricedModels: string[] = [];
  const perModel: Array<{ model: string; microcents: number }> = [];
  let microcents = 0;

  for (const consumption of consumptions) {
    const price = profile.models[consumption.model];
    if (!price) {
      if (!unpricedModels.includes(consumption.model)) unpricedModels.push(consumption.model);
      continue;
    }
    const subtotal = modelMicrocents(consumption, price);
    microcents += subtotal;
    perModel.push({ model: consumption.model, microcents: subtotal });
  }

  const webSearch = extra.webSearchRequests ?? 0;
  if (webSearch > 0 && profile.web_search_per_1000_cents > 0) {
    microcents += Math.round((webSearch / 1000) * profile.web_search_per_1000_cents * MICROCENTS_PER_CENT);
  }

  const activeSeconds = extra.activeSeconds ?? 0;
  if (activeSeconds > 0 && profile.active_hour_cents > 0) {
    microcents += Math.round((activeSeconds / SECONDS_PER_HOUR) * profile.active_hour_cents * MICROCENTS_PER_CENT);
  }

  return {
    microcents,
    // Rounded up rather than to-nearest: a client reading `list_cost` to pick a
    // new cap must not be told the session spent less than it did, because the
    // cap has to be strictly greater than the consumed value.
    cents: Math.ceil(microcents / MICROCENTS_PER_CENT),
    unpricedModels,
    perModel,
  };
}

/** Convert whole cents to the exact microcent value enforcement compares against. */
export function centsToMicrocents(cents: number): number {
  return cents * MICROCENTS_PER_CENT;
}

/**
 * Parse and validate a cost profile from untrusted input.
 *
 * Returns `undefined` on a malformed profile rather than a partially applied
 * one: a profile that silently drops half its rates would price some models
 * from the operator's numbers and others as unpriced, which reads as an
 * intermittent budget failure.
 */
export function parseCostProfile(value: unknown): CostProfile | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;

  const id = typeof record.id === 'string' && record.id.length > 0 ? record.id : 'local';
  const models: Record<string, ModelListPrice> = {};
  if (record.models !== undefined) {
    if (!record.models || typeof record.models !== 'object' || Array.isArray(record.models)) return undefined;
    for (const [model, raw] of Object.entries(record.models as Record<string, unknown>)) {
      if (!model) return undefined;
      const price = parseModelListPrice(raw);
      if (!price) return undefined;
      models[model] = price;
    }
  }

  const webSearch = parseRate(record.web_search_per_1000_cents);
  const activeHour = parseRate(record.active_hour_cents);
  if (webSearch === undefined || activeHour === undefined) return undefined;

  return {
    id,
    models,
    // Absent is not an error for these two: the local profile simply does not
    // meter runtime or web searches, which is a declared zero.
    web_search_per_1000_cents: webSearch ?? 0,
    active_hour_cents: activeHour ?? 0,
  };
}

/** Read the configured profile, or the empty one when nothing is configured. */
export function costProfileFromEnv(env: NodeJS.ProcessEnv = process.env): CostProfile {
  const raw = env[COST_PROFILE_ENV];
  if (!raw || raw.trim().length === 0) return EMPTY_COST_PROFILE;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_COST_PROFILE;
  }
  return parseCostProfile(parsed) ?? EMPTY_COST_PROFILE;
}

function parseModelListPrice(value: unknown): ModelListPrice | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const input = parseRate(record.input_per_mtok_cents);
  const output = parseRate(record.output_per_mtok_cents);
  // Required: a model entry with no token rates cannot price anything, and
  // admitting it would silently make the model look priced at zero.
  if (input === undefined || input === null || output === undefined || output === null) return undefined;
  const cacheRead = parseRate(record.cache_read_per_mtok_cents);
  const cacheWrite = parseRate(record.cache_write_per_mtok_cents);
  if (cacheRead === undefined || cacheWrite === undefined) return undefined;
  return {
    input_per_mtok_cents: input,
    output_per_mtok_cents: output,
    ...(cacheRead !== null && cacheRead !== undefined ? { cache_read_per_mtok_cents: cacheRead } : {}),
    ...(cacheWrite !== null && cacheWrite !== undefined ? { cache_write_per_mtok_cents: cacheWrite } : {}),
  };
}

/** `null` = absent (allowed); `undefined` = present but invalid. */
function parseRate(value: unknown): number | null | undefined {
  if (value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

/**
 * Which models a session will execute under.
 *
 * Used at creation to decide whether a budgeted session can be metered at all.
 * The list is a *declaration*, not a prediction: a session that later runs a
 * model nobody anticipated is caught by the consumption-derived path instead,
 * which is why both exist.
 */
export function declaredModels(models: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>();
  for (const model of models) {
    if (model && model.length > 0) seen.add(model);
  }
  return [...seen];
}

/**
 * Aggregate per-model token consumption from the append-only event log.
 *
 * Deriving from the log rather than from a running counter column keeps one
 * source of truth (`session.usage` is a projection too), and `span.model_request_end`
 * is already "one canonical usage record per model request" — the same rows the
 * token totals are summed from.
 */
export function consumptionFromEvents(events: readonly SessionEvent[]): ModelConsumption[] {
  const byModel = new Map<string, ModelConsumption>();

  for (const event of events) {
    if (event.type !== 'span.model_request_end') continue;
    // A request whose model could not be identified cannot be priced. Skipping
    // it would quietly under-report, so it is bucketed under a sentinel that no
    // profile can price, which surfaces as an unpriced model.
    const model = event.modelUsed && event.modelUsed.length > 0 ? event.modelUsed : UNKNOWN_MODEL;
    const existing = byModel.get(model) ?? { model, inputTokens: 0, outputTokens: 0 };
    existing.inputTokens += event.tokensIn ?? 0;
    existing.outputTokens += event.tokensOut ?? 0;
    byModel.set(model, existing);
  }

  return [...byModel.values()];
}

/** Sentinel for a model request the log does not attribute to a model. */
export const UNKNOWN_MODEL = '(unknown-model)';
