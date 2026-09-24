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
 * The `error.type` reported on a failed run.
 *
 * The published contract names causes (`environment_archived_error`,
 * `agent_archived_error`, `session_rate_limited_error`) and the published shape
 * requires a `type` beside the `message`. This runtime cannot supply one yet:
 * `sessionManager.create` throws bare `Error`s carrying free text
 * (`src/core/session/session-manager.ts:475`), so classifying a failure would mean
 * matching on message strings, which is a guess dressed as a taxonomy.
 *
 * So the **shape** is honoured and the vocabulary is not invented. One local type
 * says "this run failed and the runtime did not classify it", which is true, and
 * is distinguishable from any published value. Introducing the published types is
 * a change to the session-creation error path, not to this projection.
 */
const DEPLOYMENT_RUN_ERROR_TYPE = 'deployment_run_failed';

/**
 * The columns a run view needs, including the agent the run actually used.
 *
 * The agent is joined from the **session** the run created, when there is one, so
 * an id and version are the ones that ran rather than the deployment's current
 * agent. A run that failed during session creation has no session row and left no
 * record of the version it attempted, so it falls back to the deployment's current
 * `agent_id` with an explicit `version: null` — see `toDeploymentRun`.
 */
const RUN_VIEW_SELECT = `
  SELECT
    r.*,
    s.agent_id AS session_agent_id,
    s.agent_version AS session_agent_version,
    d.agent_id AS deployment_agent_id
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
  started_at: string;
  completed_at: string | null;
}

type DeploymentRunViewRow = DeploymentRunRow & {
  session_agent_id: string | null;
  session_agent_version: number | null;
  deployment_agent_id: string | null;
};

export function deploymentRunsRoutes(deps: ServerDeps, options: OperationMountOptions = {}) {
  const app = new Hono();
  const collections = collectionPager<{ id: string }>(options.pageShape ?? 'canonical');

  app.get('/', (c) => {
    const rejected = rejectUnexpectedQueryParams(c, ['deployment_id', 'has_error']);
    if (rejected) return rejected;
    const deploymentId = c.req.query('deployment_id');
    const hasError = parseHasError(c.req.query('has_error'));
    if (hasError === null) return invalid(c, 'has_error must be "true" or "false"');

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
 * `trigger_context.scheduled_at` is deliberately **absent**: the runtime records
 * when a run started, not the instant its trigger was due, and it does not persist
 * the due instant on the run row. Reporting `started_at` there would answer a
 * question about the schedule with a fact about execution. The field is omitted so
 * a caller sees it missing rather than sees a value that means something else.
 */
function toDeploymentRun(row: DeploymentRunViewRow) {
  const fromSession = row.session_agent_id !== null;
  const agentId = row.session_agent_id ?? row.deployment_agent_id;
  return {
    type: 'deployment_run',
    id: row.id,
    deployment_id: row.schedule_id,
    trigger_context: { type: triggerContextType(row.trigger_type) },
    session_id: row.session_id ?? null,
    error: row.error ? { type: DEPLOYMENT_RUN_ERROR_TYPE, message: row.error } : null,
    agent: agentId
      ? {
        type: 'agent',
        id: agentId,
        // Recorded only when a session exists to have recorded it. `null` is the
        // honest answer for a run that failed before one was created; the id above
        // is then the deployment's current agent rather than the attempted one.
        version: fromSession ? row.session_agent_version ?? null : null,
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
