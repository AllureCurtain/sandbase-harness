/**
 * Session budget tests.
 *
 * The budget is enforced against a *list cost* derived from a locally configured
 * cost profile. The behaviour worth pinning down is not "does a number appear"
 * but the three things a caller can be misled by:
 *
 * 1. a model with no list price must be refused, not priced at zero;
 * 2. the cap is compared in exact microcents, so a session just under it keeps
 *    running and one just over it stops;
 * 3. "never had a budget" and "had one removed" stay distinguishable, because
 *    the contract refuses to attach a budget in both states — but only the
 *    second records that a removal happened.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Database } from '@/core/db/database.js';
import { SessionManager } from '@/core/session/session-manager.js';
import {
  BUDGET_ERROR_CODES,
  parseSessionBudget,
  sessionSpend,
} from '@/core/session/session-budget.js';
import { computeCost, EMPTY_COST_PROFILE, type CostProfile } from '@/core/session/cost-profile.js';
import type { SessionEvent } from '@/types/session.js';

/**
 * One cent per thousand tokens, so a test can move the spend in whole cents
 * without arithmetic that obscures what it is asserting.
 */
const PROFILE: CostProfile = {
  id: 'test',
  models: {
    'model-priced': { input_per_mtok_cents: 1000, output_per_mtok_cents: 1000 },
  },
  web_search_per_1000_cents: 0,
  active_hour_cents: 0,
};

describe('parseSessionBudget', () => {
  it('accepts an integer number of cents written as a string', () => {
    const result = parseSessionBudget({ type: 'limit', max_list_cost: { amount: '125', currency: 'USD' } });
    expect(result.ok).toBe(true);
    expect(result.budget?.max_list_cost.amount).toBe('125');
  });

  it('distinguishes absent from explicit removal', () => {
    expect(parseSessionBudget(undefined)).toEqual({ ok: true, budget: undefined });
    expect(parseSessionBudget(null)).toEqual({ ok: true, remove: true });
  });

  it.each([
    ['25.00', 'a decimal amount'],
    ['0', 'zero'],
    ['-5', 'a negative amount'],
    ['0125', 'a leading zero'],
    ['$1', 'a non-numeric amount'],
    ['', 'an empty amount'],
  ])('rejects %s (%s)', (amount) => {
    const result = parseSessionBudget({ type: 'limit', max_list_cost: { amount, currency: 'USD' } });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(BUDGET_ERROR_CODES.invalidAmount);
  });

  it('rejects a currency other than USD', () => {
    const result = parseSessionBudget({ type: 'limit', max_list_cost: { amount: '100', currency: 'EUR' } });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(BUDGET_ERROR_CODES.invalidCurrency);
  });

  it('rejects a budget whose type is not limit', () => {
    const result = parseSessionBudget({ type: 'capped', max_list_cost: { amount: '100', currency: 'USD' } });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(BUDGET_ERROR_CODES.invalidShape);
  });
});

describe('computeCost', () => {
  it('is exact in microcents so the cap boundary does not depend on rounding', () => {
    const breakdown = computeCost(PROFILE, [{ model: 'model-priced', inputTokens: 3, outputTokens: 0 }]);
    // 3 tokens * 1000 cents per million tokens = 3000 microcents = 0.003 cents.
    expect(breakdown.microcents).toBe(3000);
    // Reported cents round up, so a caller reading the report never sees a spend
    // lower than what enforcement compared against.
    expect(breakdown.cents).toBe(1);
  });

  it('names every model it cannot price instead of treating it as free', () => {
    const breakdown = computeCost(PROFILE, [
      { model: 'model-priced', inputTokens: 1000, outputTokens: 0 },
      { model: 'model-unpriced', inputTokens: 999999, outputTokens: 999999 },
    ]);
    expect(breakdown.unpricedModels).toEqual(['model-unpriced']);
    // Only the priced model contributed; the total is a lower bound and the
    // caller learns that from the unpriced list rather than from a wrong number.
    expect(breakdown.microcents).toBe(1_000_000);
  });

  it('prices nothing under the empty default profile', () => {
    const breakdown = computeCost(EMPTY_COST_PROFILE, [{ model: 'model-priced', inputTokens: 10, outputTokens: 10 }]);
    expect(breakdown.unpricedModels).toEqual(['model-priced']);
    expect(breakdown.microcents).toBe(0);
  });
});

describe('SessionManager budget', () => {
  let db: Database;
  let manager: SessionManager;
  let tmpDir: string;

  const PRICED_AGENT = JSON.stringify({
    name: 'priced-agent',
    model: 'model-priced',
    system: 'You are a test agent.',
  });
  const UNPRICED_AGENT = JSON.stringify({
    name: 'unpriced-agent',
    model: 'model-unpriced',
    system: 'You are a test agent.',
  });

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ma-budget-'));
    db = new Database(join(tmpDir, 'test.db'));
    db.runMigrations();
    db.exec(`INSERT INTO environments (id, name, config) VALUES ('env_default', 'local', '{}')`);
    db.prepare('INSERT INTO agents (id, name, definition) VALUES (?, ?, ?)').run('agent_priced', 'priced-agent', PRICED_AGENT);
    db.prepare('INSERT INTO agents (id, name, definition) VALUES (?, ?, ?)').run('agent_unpriced', 'unpriced-agent', UNPRICED_AGENT);
    manager = new SessionManager(db);
    manager.setCostProfile(PROFILE);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Append a model-request record so the derived spend moves by a known amount. */
  function recordSpend(sessionId: string, tokens: number, model = 'model-priced'): void {
    manager.getEventLogger().append(sessionId, {
      type: 'span.model_request_end',
      modelUsed: model,
      tokensIn: tokens,
      tokensOut: 0,
    });
  }

  /** One cent per 1000 tokens, so `tokens` cents of spend is `tokens * 1000` tokens. */
  function tokensForCents(cents: number): number {
    return cents * 1000;
  }

  it('stores a budget at creation and echoes it back', () => {
    const session = manager.create({
      agent: 'agent_priced',
      budget: { type: 'limit', max_list_cost: { amount: '125', currency: 'USD' } },
    });
    expect(session.budget).toEqual({ type: 'limit', max_list_cost: { amount: '125', currency: 'USD' } });
    expect(manager.get(session.id)?.budget?.max_list_cost.amount).toBe('125');
  });

  it('leaves budget undefined when the session was created without one', () => {
    const session = manager.create({ agent: 'agent_priced' });
    // Not null: an undefined budget means "never had one", which is a different
    // state from "had one removed".
    expect(session.budget).toBeUndefined();
    expect(manager.get(session.id)?.budget).toBeUndefined();
  });

  it('refuses a budget when the agent runs a model with no list price', () => {
    expect(() => manager.create({
      agent: 'agent_unpriced',
      budget: { type: 'limit', max_list_cost: { amount: '100', currency: 'USD' } },
    })).toThrowError(/no list price/);
    // The refusal must not leave a session behind.
    expect(manager.list().total).toBe(0);
  });

  it('treats a session as exhausted only once the exact spend reaches the cap', () => {
    const session = manager.create({
      agent: 'agent_priced',
      budget: { type: 'limit', max_list_cost: { amount: '10', currency: 'USD' } },
    });
    // 10 cents of spend is 10000 tokens at one cent per 1000 tokens.
    recordSpend(session.id, tokensForCents(10) - 1);
    expect(manager.isBudgetExhausted(session.id)).toBe(false);

    recordSpend(session.id, 1);
    expect(manager.isBudgetExhausted(session.id)).toBe(true);
  });

  it('accepts settlement events at the cap and refuses work-starting ones', () => {
    const session = manager.create({
      agent: 'agent_priced',
      budget: { type: 'limit', max_list_cost: { amount: '1', currency: 'USD' } },
    });
    recordSpend(session.id, tokensForCents(2));

    expect(() => manager.assertSessionCanAcceptEvent(session.id, { type: 'user.message', content: [] }))
      .toThrowError(/has reached its budget/);
    // The error has to name what may still be sent, or the client can only
    // retry the same rejected event.
    expect(() => manager.assertSessionCanAcceptEvent(session.id, { type: 'user.message', content: [] }))
      .toThrowError(/user\.tool_confirmation/);

    for (const settlement of [
      { type: 'user.tool_confirmation' as const, tool_use_id: 'tu_1', result: 'allow' as const },
      // The published whitelist calls this `user.tool_result`; this runtime's
      // externally executed tool results arrive under the custom-tool name, so
      // that is the event a client can actually send at the cap.
      { type: 'user.custom_tool_result' as const, custom_tool_use_id: 'ctu_1', content: [] },
      { type: 'user.interrupt' as const },
    ]) {
      expect(() => manager.assertSessionCanAcceptEvent(session.id, settlement)).not.toThrow();
    }
  });

  it('does not refuse events for a session with no budget', () => {
    const session = manager.create({ agent: 'agent_priced' });
    recordSpend(session.id, tokensForCents(10_000));
    expect(manager.isBudgetExhausted(session.id)).toBe(false);
    expect(() => manager.assertSessionCanAcceptEvent(session.id, { type: 'user.message', content: [] })).not.toThrow();
  });

  it('raises the cap and refuses a new cap at or below what was already spent', () => {
    const session = manager.create({
      agent: 'agent_priced',
      budget: { type: 'limit', max_list_cost: { amount: '10', currency: 'USD' } },
    });
    recordSpend(session.id, tokensForCents(15));

    expect(() => manager.update(session.id, {
      budget: { type: 'limit', max_list_cost: { amount: '15', currency: 'USD' } },
    })).toThrowError(/must be greater than the session's consumed list cost/);

    const raised = manager.update(session.id, {
      budget: { type: 'limit', max_list_cost: { amount: '50', currency: 'USD' } },
    });
    expect(raised.budget?.max_list_cost.amount).toBe('50');
    expect(manager.isBudgetExhausted(session.id)).toBe(false);
  });

  it('removes a budget and remembers that a removal happened', () => {
    const session = manager.create({
      agent: 'agent_priced',
      budget: { type: 'limit', max_list_cost: { amount: '10', currency: 'USD' } },
    });
    manager.update(session.id, { budget: null });

    expect(manager.get(session.id)?.budget).toBeNull();
    // Re-adding is refused after removal, which is why the row has to keep the
    // removal rather than just clearing the column.
    expect(() => manager.update(session.id, {
      budget: { type: 'limit', max_list_cost: { amount: '99', currency: 'USD' } },
    })).toThrowError(/cannot be re-added/);
  });

  it('refuses to attach a budget to a session that never had one', () => {
    const session = manager.create({ agent: 'agent_priced' });
    expect(() => manager.update(session.id, {
      budget: { type: 'limit', max_list_cost: { amount: '10', currency: 'USD' } },
    })).toThrowError(/can only be attached when the session is created/);
  });

  it('cannot meter a session that later consumes an unpriced model', () => {
    const session = manager.create({
      agent: 'agent_priced',
      budget: { type: 'limit', max_list_cost: { amount: '1000', currency: 'USD' } },
    });
    // A model nobody declared — a delegation could do this in production.
    recordSpend(session.id, 1000, 'model-unpriced');
    expect(manager.isBudgetExhausted(session.id)).toBe(true);
    expect(() => manager.update(session.id, {
      budget: { type: 'limit', max_list_cost: { amount: '2000', currency: 'USD' } },
    })).toThrowError(/no list price/);
  });

  it('reports list_cost and the budget echo in the usage payload', () => {
    const session = manager.create({
      agent: 'agent_priced',
      budget: { type: 'limit', max_list_cost: { amount: '100', currency: 'USD' } },
    });
    recordSpend(session.id, tokensForCents(7));

    const usage = manager.buildUsagePayload(session.id);
    expect(usage.list_cost).toBe(7);
    expect(usage.budget?.max_list_cost.amount).toBe('100');
    expect(usage.server_tool_use).toEqual({ web_search_requests: 0, web_fetch_requests: 0 });
  });

  it('omits list_cost rather than reporting a lower bound as the total', () => {
    const session = manager.create({ agent: 'agent_priced' });
    recordSpend(session.id, tokensForCents(7), 'model-unpriced');

    const usage = manager.buildUsagePayload(session.id);
    expect(usage.list_cost).toBeUndefined();
    // A session with no budget still reports that fact explicitly.
    expect(usage.budget).toBeNull();
  });

  it('derives spend from the log, so it survives a restart', () => {
    const session = manager.create({
      agent: 'agent_priced',
      budget: { type: 'limit', max_list_cost: { amount: '100', currency: 'USD' } },
    });
    recordSpend(session.id, tokensForCents(7));

    const events = manager.getEventLogger().getEvents(session.id) as SessionEvent[];
    expect(sessionSpend(db, session.id, PROFILE, events).cents).toBe(7);

    // A second manager over the same database sees the same spend: nothing was
    // cached in memory.
    const reopened = new SessionManager(db);
    reopened.setCostProfile(PROFILE);
    expect(reopened.getSessionSpend(session.id).cents).toBe(7);
    expect(reopened.isBudgetExhausted(session.id)).toBe(false);
  });
});
