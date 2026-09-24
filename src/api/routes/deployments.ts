import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import type { ServerDeps } from '../server.js';
import { collectionPager } from '../standard.js';
import { nextCronRun, runDueScheduledDeployments, runSchedule } from '@/core/operations/scheduler.js';
import { isValidTimeZone } from '@/core/operations/cron.js';
import {
  archiveById,
  invalid,
  notFound,
  now,
  objectField,
  parseObject,
  readObjectBody,
  stringField,
  type JsonObject,
  type OperationMountOptions,
} from './operation-helpers.js';

/**
 * Scheduled deployments, addressed at two prefixes.
 *
 * The published contract calls this resource a *deployment* and addresses it at
 * `/v1/deployments*`; this runtime has always called it a *scheduled deployment*
 * and served it at `/v1/scheduled-deployments*`. Both spellings are served.
 *
 * The routes are declared **relative to the mount** and `operations.ts` mounts
 * this one factory at `/scheduled-deployments` and at `/deployments`, so there is
 * one registration list and the two prefixes cannot drift route by route. A
 * curated per-route alias list is exactly the thing that drifts, leaving a route
 * that answers for one caller and 404s for another on the same resource.
 *
 * Two constraints shape this file, and both are load-bearing:
 *
 * 1. The paths must stay **literals**, and the aliasing must happen at
 *    `app.route()`. `tests/unit/support/route-table.ts` expands
 *    `app.<method>('<literal>'` and `app.route('<prefix>', factory)` statically
 *    from source text, so a path built from a base-path variable would make these
 *    routes invisible to the Console's API-reference guard and to
 *    `contract-honesty` while they kept working — a guard reporting green over a
 *    real divergence.
 * 2. This factory must live in its **own module** and be imported by
 *    `operations.ts`, because that parser only follows a mount whose factory is
 *    an imported identifier. Defining it in the same file as the mount would
 *    leave it unresolved and drop every deployment route from the table.
 *
 * `operations.ts` serves four resource families from one router mounted at `/v1`
 * and mirrored at `/v1/x`. That is why the deployments were **extracted** rather
 * than aliased in place: making that router's paths relative and remounting it
 * would have put `/webhooks` and `/outcomes` under `/v1/deployments/` as well.
 * Mounting this factory inside `operationsRoutes` (rather than in `server.ts`)
 * deliberately preserves the existing `/v1/x/scheduled-deployments` mirror, which
 * `tests/integration/operations-collection-envelope.test.ts` asserts, and gives
 * `/v1/x/deployments` the same legacy envelope as its canonical-prefix twin.
 */
export function deploymentRoutes(deps: ServerDeps, options: OperationMountOptions = {}) {
  const app = new Hono();
  const collections = collectionPager<{ id: string }>(options.pageShape ?? 'canonical');

  app.get('/', (c) => {
    const rows = deps.db.prepare('SELECT * FROM scheduled_deployments WHERE archived_at IS NULL ORDER BY created_at DESC').all() as ScheduledDeploymentRow[];
    return collections.json(c, rows.map(toScheduledDeployment));
  });

  app.post('/', async (c) => {
    const body = await readObjectBody(c);
    if (!body.ok) return body.response;
    const name = stringField(body.value.name);
    const agentId = stringField(body.value.agent_id) ?? stringField(body.value.agent);
    if (!name) return invalid(c, 'name is required');
    if (!agentId) return invalid(c, 'agent_id is required');
    const schedule = parseScheduleFields(body.value);
    if (!schedule.ok) return invalid(c, schedule.message);
    const id = `sched_${nanoid(18)}`;
    deps.db.prepare(`
      INSERT INTO scheduled_deployments (
        id, name, agent_id, environment_id, cron, timezone, payload, status, next_run_at, metadata, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      name,
      agentId,
      stringField(body.value.environment_id) ?? null,
      schedule.expression,
      schedule.timezone,
      JSON.stringify(objectField(body.value.payload)),
      normalizeScheduleStatus(body.value.status),
      stringField(body.value.next_run_at) ?? nextCronRun(schedule.expression, new Date(), schedule.timezone)?.toISOString() ?? null,
      JSON.stringify(objectField(body.value.metadata)),
      now(),
      now(),
    );
    const row = deps.db.prepare('SELECT * FROM scheduled_deployments WHERE id = ?').get(id) as ScheduledDeploymentRow;
    return c.json(toScheduledDeployment(row), 201);
  });

  app.post('/run-due', (c) => {
    const runs = runDueScheduledDeployments(deps.db, deps.sessionManager);
    return collections.json(c, runs.map(toScheduledDeploymentRun), 202);
  });

  app.get('/:id', (c) => {
    const row = deps.db.prepare('SELECT * FROM scheduled_deployments WHERE id = ? AND archived_at IS NULL').get(c.req.param('id')) as ScheduledDeploymentRow | undefined;
    return row ? c.json(toScheduledDeployment(row)) : notFound(c, 'Scheduled deployment not found');
  });

  app.put('/:id', async (c) => {
    const body = await readObjectBody(c);
    if (!body.ok) return body.response;
    const id = c.req.param('id');
    const existing = deps.db.prepare('SELECT * FROM scheduled_deployments WHERE id = ? AND archived_at IS NULL').get(id) as ScheduledDeploymentRow | undefined;
    if (!existing) return notFound(c, 'Scheduled deployment not found');
    const storedTimeZone = existing.timezone || 'UTC';
    const schedule = parseScheduleFields({
      cron: body.value.cron ?? existing.cron,
      timezone: body.value.timezone ?? storedTimeZone,
      schedule: body.value.schedule,
    });
    if (!schedule.ok) return invalid(c, schedule.message);
    // An update that moves the cadence re-arms the next run in the resolved zone
    // unless the caller supplied one, so changing only the timezone moves the
    // schedule instead of leaving it at the instant the previous zone produced.
    const cadenceChanged = schedule.expression !== existing.cron || schedule.timezone !== storedTimeZone;
    const computedNextRunAt = nextCronRun(schedule.expression, new Date(), schedule.timezone)?.toISOString() ?? null;
    const nextRunAt = body.value.next_run_at === undefined
      ? (cadenceChanged ? computedNextRunAt : existing.next_run_at)
      : stringField(body.value.next_run_at) ?? computedNextRunAt;
    deps.db.prepare(`
      UPDATE scheduled_deployments
      SET name = ?, agent_id = ?, environment_id = ?, cron = ?, timezone = ?, payload = ?, status = ?,
          next_run_at = ?, metadata = ?, updated_at = ?
      WHERE id = ?
    `).run(
      stringField(body.value.name) ?? existing.name,
      stringField(body.value.agent_id) ?? stringField(body.value.agent) ?? existing.agent_id,
      body.value.environment_id === undefined ? existing.environment_id : stringField(body.value.environment_id) ?? null,
      schedule.expression,
      schedule.timezone,
      JSON.stringify(body.value.payload === undefined ? parseObject(existing.payload) : objectField(body.value.payload)),
      normalizeScheduleStatus(body.value.status ?? existing.status),
      nextRunAt,
      JSON.stringify(body.value.metadata === undefined ? parseObject(existing.metadata) : objectField(body.value.metadata)),
      now(),
      id,
    );
    const row = deps.db.prepare('SELECT * FROM scheduled_deployments WHERE id = ?').get(id) as ScheduledDeploymentRow;
    return c.json(toScheduledDeployment(row));
  });

  app.post('/:id/archive', (c) => archiveById(c, deps, 'scheduled_deployments', toScheduledDeployment, 'Scheduled deployment not found'));

  app.get('/:id/runs', (c) => {
    const schedule = deps.db.prepare('SELECT id FROM scheduled_deployments WHERE id = ? AND archived_at IS NULL').get(c.req.param('id'));
    if (!schedule) return notFound(c, 'Scheduled deployment not found');
    const rows = deps.db.prepare('SELECT * FROM scheduled_deployment_runs WHERE schedule_id = ? ORDER BY started_at DESC').all(c.req.param('id')) as ScheduledDeploymentRunRow[];
    return collections.json(c, rows.map(toScheduledDeploymentRun));
  });

  app.post('/:id/run', async (c) => {
    const body = await readObjectBody(c);
    if (!body.ok) return body.response;
    const schedule = deps.db.prepare('SELECT * FROM scheduled_deployments WHERE id = ? AND archived_at IS NULL').get(c.req.param('id')) as ScheduledDeploymentRow | undefined;
    if (!schedule) return notFound(c, 'Scheduled deployment not found');
    if (schedule.status !== 'active') return invalid(c, 'scheduled deployment must be active before it can run');
    const payload = {
      ...parseObject(schedule.payload),
      ...objectField(body.value.payload),
    };
    const manualSchedule = {
      ...schedule,
      payload: JSON.stringify(payload),
    };
    try {
      const row = runSchedule(deps.db, deps.sessionManager, manualSchedule, stringField(body.value.trigger_type) ?? 'manual');
      return c.json(toScheduledDeploymentRun(row), 201);
    } catch (err: any) {
      return c.json({ error: { type: 'internal_error', message: err?.message ?? String(err) } }, 500);
    }
  });

  return app;
}

function toScheduledDeployment(row: ScheduledDeploymentRow) {
  return {
    id: row.id,
    type: 'scheduled_deployment',
    name: row.name,
    agent_id: row.agent_id,
    environment_id: row.environment_id ?? null,
    cron: row.cron,
    timezone: row.timezone || 'UTC',
    payload: parseObject(row.payload),
    status: row.archived_at ? 'archived' : row.status,
    last_run_at: row.last_run_at ?? null,
    next_run_at: row.next_run_at ?? null,
    metadata: parseObject(row.metadata),
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived_at: row.archived_at ?? null,
  };
}

function toScheduledDeploymentRun(row: ScheduledDeploymentRunRow) {
  return {
    id: row.id,
    type: 'scheduled_deployment_run',
    schedule_id: row.schedule_id,
    session_id: row.session_id ?? null,
    status: row.status,
    trigger_type: row.trigger_type,
    payload: parseObject(row.payload),
    error: row.error ?? null,
    started_at: row.started_at,
    completed_at: row.completed_at ?? null,
  };
}

function looksLikeCron(value: string) {
  return value.trim().split(/\s+/).length === 5;
}

type ScheduleFieldsResult =
  | { ok: true; expression: string; timezone: string }
  | { ok: false; message: string };

/**
 * Read the cadence and its zone from either the flat local fields or the
 * canonical object.
 *
 * The published deployments API takes `schedule: { type: 'cron', expression,
 * timezone }`, while this runtime has always taken a flat `cron` string. Both
 * are accepted and resolved to one pair, so a canonical client and an existing
 * local one cannot disagree about what a deployment's cadence is.
 *
 * The zone is validated rather than defaulted: an unknown name would make
 * `nextCronRun` return `null`, and a deployment whose cadence silently stopped
 * resolving looks identical to one that simply has not come due yet.
 */
function parseScheduleFields(value: Record<string, unknown>): ScheduleFieldsResult {
  const nested = value.schedule && typeof value.schedule === 'object' && !Array.isArray(value.schedule)
    ? value.schedule as Record<string, unknown>
    : undefined;
  const expression = stringField(nested?.expression) ?? stringField(value.cron);
  if (!expression) return { ok: false, message: 'cron is required' };
  if (!looksLikeCron(expression)) return { ok: false, message: 'cron must contain five fields' };
  const timezone = stringField(nested?.timezone) ?? stringField(value.timezone) ?? 'UTC';
  if (!isValidTimeZone(timezone)) {
    return { ok: false, message: `timezone must be an IANA time zone identifier (got "${timezone}")` };
  }
  return { ok: true, expression, timezone };
}

function normalizeScheduleStatus(value: unknown): 'active' | 'paused' {
  return value === 'paused' ? 'paused' : 'active';
}

type ScheduledDeploymentRow = {
  id: string;
  name: string;
  agent_id: string;
  environment_id: string | null;
  cron: string;
  timezone: string;
  payload: string;
  status: string;
  last_run_at: string | null;
  next_run_at: string | null;
  metadata: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

type ScheduledDeploymentRunRow = {
  id: string;
  schedule_id: string;
  session_id: string | null;
  status: string;
  trigger_type: string;
  payload: string;
  error: string | null;
  started_at: string;
  completed_at: string | null;
};
