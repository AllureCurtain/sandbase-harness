/**
 * Deployment runs, as a top-level collection.
 *
 * A deployment run is the record of one attempt to trigger a deployment. The rows
 * have existed since the scheduler was written and are already reachable nested
 * under one deployment (`GET /v1/deployments/{id}/runs`), but the published
 * contract addresses them as their own resource with its own id:
 *
 *   GET /v1/deployment_runs?deployment_id=...&has_error=true
 *   GET /v1/deployment_runs/{deployment_run_id}
 *
 * The second one is not a convenience. A `deployment_run` webhook event carries a
 * run id in `data.id`, so a runtime that can publish the id but not resolve it
 * hands the caller an identifier that goes nowhere.
 *
 * This module is a **read view**, not a second store. Nothing here writes, and the
 * stored column names are untouched: `schedule_id` and `started_at` are renamed on
 * the way out and never on the way in, so the nested route's shape and every write
 * path are unaffected. Two projections of one row is a divergence risk, so the two
 * are pinned against each other by a test that asserts they agree on every run
 * they both describe.
 */
import { Hono } from 'hono';
import type { ServerDeps } from '../server.js';
import { collectionPager } from '../standard.js';
import { invalid, notFound, type OperationMountOptions } from './operation-helpers.js';
import { rejectUnexpectedQueryParams } from './query-params.js';

/**
 * The columns a run view needs, including the agent the run actually used.
 *
 * The agent is joined from the **session** the run created, when there is one, so
 * an id and version are the ones that ran rather than the deployment's current
 * agent. A run that failed during session creation has no session row and left no
 * record of the version it attempted, so it falls back to the deployment's current
 * `agent_id` with an explicit `version: null` — see `toDeploymentRun`.
 */
export const RUN_VIEW_SELECT = `
  SELECT
    r.*,
    s.agent_id AS session_agent_id,
    s.agent_version AS session_agent_version,
    d.agent_id AS deployment_agent_id,
    d.agent_version AS deployment_agent_version
  FROM scheduled_deployment_runs r
  LEFT JOIN sessions s ON s.id = r.session_id
  LEFT JOIN scheduled_deployments d ON d.id = r.schedule_id
`;

interface DeploymentRunRow {
  id: string;
  schedule_id: string;
  session_id: string | null;
  status: string;
  trigger_type: string;
  payload: string;
  error: string | null;
  scheduled_at: string | null;
  error_type: string | null;
  started_at: string;
  completed_at: string | null;
}

export type DeploymentRunViewRow = DeploymentRunRow & {
  session_agent_id: string | null;
  session_agent_version: number | null;
  deployment_agent_id: string | null;
  deployment_agent_version: number | null;
};

export function deploymentRunsRoutes(deps: ServerDeps, options: OperationMountOptions = {}) {
  const app = new Hono();
  const collections = collectionPager<{ id: string }>(options.pageShape ?? 'canonical');

  app.get('/', (c) => {
    const rejected = rejectUnexpectedQueryParams(c, RUN_LIST_PARAMS);
    if (rejected) return rejected;
    const deploymentId = c.req.query('deployment_id');
    const hasError = parseHasError(c.req.query('has_error'));
    if (hasError === null) return invalid(c, 'has_error must be "true" or "false"');
    const triggerType = c.req.query('trigger_type');
    if (triggerType !== undefined && triggerType !== 'schedule' && triggerType !== 'manual') {
      return invalid(c, 'trigger_type must be "schedule" or "manual"');
    }

    // `deployment_id` is the published filter name; the column it selects on keeps
    // its local spelling. Which is the whole point of a projection.
    const conditions: string[] = [];
    const parameters: string[] = [];
    if (deploymentId !== undefined) {
      conditions.push('r.schedule_id = ?');
      parameters.push(deploymentId);
    }
    if (hasError !== undefined) {
      conditions.push(hasError ? 'r.error IS NOT NULL' : 'r.error IS NULL');
    }
    if (triggerType !== undefined) {
      // The stored vocabulary is `scheduled`; the published filter word is
      // `schedule` — the same translation `trigger_context` performs on reads.
      conditions.push('r.trigger_type = ?');
      parameters.push(triggerType === 'schedule' ? 'scheduled' : triggerType);
    }
    const createdBounds: Array<[string, string]> = [
      ['created_at[gt]', '>'],
      ['created_at[gte]', '>='],
      ['created_at[lt]', '<'],
      ['created_at[lte]', '<='],
    ];
    for (const [param, operator] of createdBounds) {
      const bound = c.req.query(param);
      if (bound !== undefined) {
        conditions.push(`r.started_at ${operator} ?`);
        parameters.push(bound);
      }
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = deps.db
      .prepare(`${RUN_VIEW_SELECT} ${where} ORDER BY r.started_at DESC`)
      .all(...parameters) as unknown as DeploymentRunViewRow[];
    return collections.json(c, rows.map(toDeploymentRun));
  });

  app.get('/:id', (c) => {
    const row = deps.db
      .prepare(`${RUN_VIEW_SELECT} WHERE r.id = ?`)
      .get(c.req.param('id')) as unknown as DeploymentRunViewRow | undefined;
    if (!row) return notFound(c, 'Deployment run not found');
    return c.json(toDeploymentRun(row));
  });

  return app;
}

/**
 * The published list-filter set, plus the local pagination trio.
 */
const RUN_LIST_PARAMS = [
  'deployment_id',
  'has_error',
  'trigger_type',
  'created_at[gt]',
  'created_at[gte]',
  'created_at[lt]',
  'created_at[lte]',
  'limit',
  'page',
] as const;

/**
 * `true` / `false`, `undefined` when absent, and `null` when it is neither.
 *
 * A known parameter with an unusable value is refused by name rather than ignored,
 * which is how `level` is handled on the log route (`src/api/routes/runtime.ts:73`).
 * Ignoring it would answer a filtered question with an unfiltered list, and the
 * caller has no way to tell.
 */
function parseHasError(raw: string | undefined): boolean | undefined | null {
  if (raw === undefined) return undefined;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return null;
}

/**
 * The published projection of one run.
 *
 * `trigger_context` carries `scheduled_at` once it is recorded: the scheduler
 * persists the due instant the pass matched on, so a schedule run reports the
 * cron instant it answered rather than the wall-clock moment execution began.
 * Rows written before that column existed report the trigger type alone.
 *
 * `error.type` is the classified vocabulary the scheduler writes
 * (`environment_archived_error`, `vault_not_found_error`, …); rows recorded
 * before classification existed carry `unknown_error`, which is the honest
 * answer for "the runtime did not classify this".
 *
 * `agent` is the version that ran — read from the session when one exists —
 * falling back to the deployment's pinned version for a run that failed before
 * a session could record one.
 */
export function toDeploymentRun(row: DeploymentRunViewRow) {
  const agentId = row.session_agent_id ?? row.deployment_agent_id;
  const scheduled = row.trigger_type === 'scheduled';
  return {
    type: 'deployment_run',
    id: row.id,
    deployment_id: row.schedule_id,
    trigger_context: scheduled
      ? { type: 'schedule', ...(row.scheduled_at ? { scheduled_at: row.scheduled_at } : {}) }
      : { type: triggerContextType(row.trigger_type) },
    session_id: row.session_id ?? null,
    error: row.error
      ? { type: row.error_type ?? 'unknown_error', message: row.error }
      : null,
    agent: agentId
      ? {
        type: 'agent',
        id: agentId,
        version: row.session_agent_version ?? row.deployment_agent_version ?? null,
      }
      : null,
    created_at: row.started_at,
  };
}

/**
 * The trigger vocabulary, translated where the published word differs.
 *
 * The runtime stores `scheduled`; the published `trigger_context.type` for a timed
 * run is `schedule`. `manual` is passed through unchanged — the published docs show
 * only the timed case, so there is no published word to translate it to, and
 * inventing one would be worse than reporting the value the runtime records.
 */
function triggerContextType(triggerType: string): string {
  return triggerType === 'scheduled' ? 'schedule' : triggerType;
}
